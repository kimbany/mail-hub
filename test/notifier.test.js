const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mailhub-notifier-'));
delete process.env.DATABASE_URL;
delete process.env.MASTER_KEY;

const webpush = require('web-push');
const mail = require('../src/mail');
const store = require('../src/store');
const notifier = require('../src/notifier');

test('첫 확인은 기준점만 잡고, 그 뒤 새 메일만 알린다', async () => {
  await store.init();
  const sent = [];
  webpush.sendNotification = async (sub, body) => { sent.push(JSON.parse(body)); };
  let inbox = { uidValidity: '7', uidNext: 11, messages: [] };
  const calls = [];
  mail.newSince = async (acc, lastUid) => { calls.push(lastUid); return inbox; };

  const acc = store.addAccount({ provider: 'naver', email: 'me@naver.com', label: '네이버', host: 'h', port: 993, password: 'pw' });
  notifier.setupVapid();

  await notifier.checkAll();
  assert.deepStrictEqual(calls, [], '구독한 기기가 없으면 메일 서버에 접속하지 않는다');

  await store.addPushSub({ endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' } });
  await notifier.checkAll();
  assert.strictEqual(sent.length, 0, '처음에는 알리지 않는다');
  assert.deepStrictEqual(store.getSeen(acc.id), { uidValidity: '7', uid: 10 });

  inbox = { uidValidity: '7', uidNext: 12, messages: [{ uid: 11, subject: '안녕하세요', from: '김철수 <kim@x.com>', to: '' }] };
  await notifier.checkAll();
  assert.strictEqual(calls.at(-1), 10);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].title, '김철수 · 네이버');
  assert.strictEqual(sent[0].body, '안녕하세요');
  assert.strictEqual(store.getSeen(acc.id).uid, 11);

  inbox = { uidValidity: '7', uidNext: 14, messages: [{ uid: 12, subject: 'A', from: 'a', to: '' }, { uid: 13, subject: 'B', from: 'b', to: '' }] };
  await notifier.checkAll();
  assert.strictEqual(sent[1].title, '새 메일 2통 · 네이버');

  inbox = { uidValidity: '8', uidNext: 3, messages: [{ uid: 1, subject: 'old', from: 'x', to: '' }] };
  await notifier.checkAll();
  assert.strictEqual(sent.length, 2, '메일함이 재구성되면 기준점만 다시 잡는다');
  assert.deepStrictEqual(store.getSeen(acc.id), { uidValidity: '8', uid: 2 });
});

test('폰에서 알림을 끈(410) 구독은 지운다', async () => {
  webpush.sendNotification = async () => { const e = new Error('gone'); e.statusCode = 410; throw e; };
  await notifier.send({ title: 't' });
  assert.strictEqual(store.listPushSubs().length, 0);
});
