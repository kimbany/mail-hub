const path = require('path');
const crypto = require('crypto');
const express = require('express');
const store = require('./store');
const mail = require('./mail');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- 사이트 로그인 (메모리 세션, httpOnly 쿠키) ----
const sessions = new Map();
const SESSION_MS = 12 * 60 * 60 * 1000;

function getCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return m ? m[1] : null;
}
function startSession(res) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_MS);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`);
}
function loggedIn(req) {
  const t = getCookie(req, 'sid');
  const exp = t && sessions.get(t);
  if (!exp || exp < Date.now()) { if (t) sessions.delete(t); return false; }
  return true;
}
function auth(req, res, next) {
  if (!loggedIn(req)) return res.status(401).json({ error: '로그인이 필요합니다.' });
  next();
}

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error(e);
    res.status(500).json({ error: friendlyError(e) });
  });

function friendlyError(e) {
  const msg = String((e && (e.responseText || e.message)) || e);
  if (e && e.authenticationFailed) return '로그인 실패: 아이디/앱 비밀번호와 IMAP 사용 설정을 확인하세요.';
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT/.test(msg)) return `메일 서버에 연결할 수 없습니다 (${msg}).`;
  return msg;
}

app.get('/api/status', (req, res) => res.json({ setup: store.isSetup(), loggedIn: loggedIn(req) }));

app.post('/api/setup', (req, res) => {
  if (store.isSetup()) return res.status(400).json({ error: '이미 비밀번호가 설정되어 있습니다.' });
  const { password } = req.body || {};
  if (!password || password.length < 8) return res.status(400).json({ error: '비밀번호는 8자 이상이어야 합니다.' });
  store.setPassword(password);
  startSession(res);
  res.json({ ok: true });
});

let failed = 0;
app.post('/api/login', (req, res) => {
  if (failed >= 10) return res.status(429).json({ error: '시도가 너무 많습니다. 서버를 다시 시작하세요.' });
  if (!store.checkPassword((req.body || {}).password || '')) {
    failed++;
    return res.status(401).json({ error: '비밀번호가 틀렸습니다.' });
  }
  failed = 0;
  startSession(res);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  sessions.delete(getCookie(req, 'sid'));
  res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

// ---- 계정 ----
app.get('/api/providers', (req, res) => res.json(mail.PROVIDERS));
app.get('/api/accounts', auth, (req, res) => res.json(store.listAccounts()));

app.post('/api/accounts', auth, wrap(async (req, res) => {
  const { provider, email, password, label } = req.body || {};
  let { host, port } = req.body || {};
  const p = mail.PROVIDERS[provider];
  if (p) { host = p.host; port = p.port; }
  if (!email || !password || !host) return res.status(400).json({ error: '메일 주소, 비밀번호, 서버 정보가 필요합니다.' });
  port = Number(port) || 993;
  await mail.testLogin({ host, port, email, password }); // 저장 전에 실제로 로그인되는지 확인
  res.json(store.addAccount({ provider: provider || 'custom', email, label, host, port, password }));
}));

app.delete('/api/accounts/:id', auth, (req, res) => {
  store.removeAccount(req.params.id);
  cache.delete(req.params.id);
  res.json({ ok: true });
});

// ---- 메일 ----
const cache = new Map(); // accountId -> { at, list }
const CACHE_MS = 60 * 1000;

app.get('/api/accounts/:id/messages', auth, wrap(async (req, res) => {
  const acc = store.getAccountWithSecret(req.params.id);
  if (!acc) return res.status(404).json({ error: '계정을 찾을 수 없습니다.' });
  let entry = cache.get(acc.id);
  if (!entry || req.query.refresh || Date.now() - entry.at > CACHE_MS) {
    entry = { at: Date.now(), list: await mail.listInbox(acc, Math.min(Number(req.query.limit) || 50, 200)) };
    cache.set(acc.id, entry);
  }
  const rules = store.listRules(acc.id);
  res.json(entry.list.map((m) => ({ ...m, category: mail.classify(m, rules) })));
}));

app.get('/api/accounts/:id/messages/:uid', auth, wrap(async (req, res) => {
  const acc = store.getAccountWithSecret(req.params.id);
  if (!acc) return res.status(404).json({ error: '계정을 찾을 수 없습니다.' });
  const m = await mail.getMessage(acc, Number(req.params.uid));
  if (!m) return res.status(404).json({ error: '메일을 찾을 수 없습니다.' });
  res.json(m);
}));

// ---- 분류 규칙 ----
app.get('/api/accounts/:id/rules', auth, (req, res) => res.json(store.listRules(req.params.id)));

app.post('/api/accounts/:id/rules', auth, (req, res) => {
  const { category, field, keyword } = req.body || {};
  if (!category || !keyword || !['from', 'subject'].includes(field)) {
    return res.status(400).json({ error: '분류 이름, 대상(보낸사람/제목), 키워드가 필요합니다.' });
  }
  res.json(store.addRule({ accountId: req.params.id, category: category.trim(), field, keyword: keyword.trim() }));
});

app.delete('/api/rules/:id', auth, (req, res) => {
  store.removeRule(req.params.id);
  res.json({ ok: true });
});

if (require.main === module) {
  app.listen(PORT, HOST, () => console.log(`메일 통합 조회: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`));
}

module.exports = app;
