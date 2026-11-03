const path = require('path');
const crypto = require('crypto');
const express = require('express');
const store = require('./store');
const mail = require('./mail');

const PORT = Number(process.env.PORT || 3000);
// Render 같은 호스팅에서는 외부 접속을 받아야 하므로 0.0.0.0, 내 PC 에서는 127.0.0.1.
const HOST = process.env.HOST || (process.env.RENDER ? '0.0.0.0' : '127.0.0.1');
const PUBLIC = !['127.0.0.1', 'localhost', '::1'].includes(HOST);

const app = express();
app.set('trust proxy', 1); // HTTPS 프록시 뒤에서 req.secure 를 올바르게 판단
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  // 메일 본문 iframe(srcdoc)은 이 정책을 물려받지 않도록 frame-src 를 허용하고, 앱 자체는 자기 스크립트만 쓴다.
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: http:; font-src 'self' https: data:; frame-src 'self' about:; object-src 'none'; base-uri 'none'; form-action 'self'");
  next();
});
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- 사이트 로그인 (메모리 세션, httpOnly 쿠키) ----
const sessions = new Map();
const SESSION_MS = 12 * 60 * 60 * 1000;

function getCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return m ? m[1] : null;
}
function startSession(req, res) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_MS);
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure}`);
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

app.get('/healthz', (req, res) => res.send('ok'));
app.get('/api/status', (req, res) => res.json({ setup: store.isSetup(), loggedIn: loggedIn(req) }));

app.post('/api/setup', (req, res) => {
  if (store.isSetup()) return res.status(400).json({ error: '이미 비밀번호가 설정되어 있습니다.' });
  const { password } = req.body || {};
  if (!password || password.length < 8) return res.status(400).json({ error: '비밀번호는 8자 이상이어야 합니다.' });
  store.setPassword(password);
  startSession(req, res);
  res.json({ ok: true });
});

// 비밀번호를 연달아 틀리면 잠시 잠근다 (5번 틀릴 때마다 15분).
let failed = 0;
let lockedUntil = 0;
app.post('/api/login', (req, res) => {
  if (Date.now() < lockedUntil) {
    const min = Math.ceil((lockedUntil - Date.now()) / 60000);
    return res.status(429).json({ error: `비밀번호를 여러 번 틀려서 ${min}분 동안 잠겼습니다.` });
  }
  if (!store.checkPassword((req.body || {}).password || '')) {
    if (++failed % 5 === 0) lockedUntil = Date.now() + 15 * 60 * 1000;
    return res.status(401).json({ error: '비밀번호가 틀렸습니다.' });
  }
  failed = 0;
  startSession(req, res);
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

// 계정 하나의 받은메일 목록 (1분 캐시). 전체 메일함도 이 캐시를 같이 쓴다.
async function inboxOf(acc, { refresh, limit } = {}) {
  let entry = cache.get(acc.id);
  if (!entry || refresh || Date.now() - entry.at > CACHE_MS) {
    entry = { at: Date.now(), list: await mail.listInbox(acc, Math.min(Number(limit) || 50, 200)) };
    cache.set(acc.id, entry);
  }
  return entry.list;
}

app.get('/api/accounts/:id/messages', auth, wrap(async (req, res) => {
  const acc = store.getAccountWithSecret(req.params.id);
  if (!acc) return res.status(404).json({ error: '계정을 찾을 수 없습니다.' });
  const list = await inboxOf(acc, req.query);
  const rules = store.listRules(acc.id);
  res.json(list.map((m) => ({ ...m, accountId: acc.id, category: mail.classify(m, rules) })));
}));

// 전체 메일함: 모든 계정의 받은메일을 날짜순으로 합치고, "전체 분류" 규칙으로 분류한다.
// 한 계정이 실패해도 나머지는 보여주고, 실패한 계정은 errors 로 알려준다.
app.get('/api/all/messages', auth, wrap(async (req, res) => {
  const rules = store.listRules(store.ALL);
  const errors = [];
  const lists = await Promise.all(store.listAccounts().map(async (a) => {
    try {
      const list = await inboxOf(store.getAccountWithSecret(a.id), req.query);
      return list.map((m) => ({ ...m, accountId: a.id, category: mail.classify(m, rules) }));
    } catch (e) {
      errors.push({ accountId: a.id, label: a.label, error: friendlyError(e) });
      return [];
    }
  }));
  const messages = lists.flat().sort((x, y) => new Date(y.date || 0) - new Date(x.date || 0));
  res.json({ messages, errors });
}));

app.get('/api/accounts/:id/messages/:uid', auth, wrap(async (req, res) => {
  const acc = store.getAccountWithSecret(req.params.id);
  if (!acc) return res.status(404).json({ error: '계정을 찾을 수 없습니다.' });
  const m = await mail.getMessage(acc, Number(req.params.uid));
  if (!m) return res.status(404).json({ error: '메일을 찾을 수 없습니다.' });
  res.json(m);
}));

// ---- 분류 규칙 ----
// 계정 id 자리에 "__all" 을 쓰면 전체 메일함의 분류 규칙이다.
const ruleOwnerOk = (id) => id === store.ALL || store.listAccounts().some((a) => a.id === id);

app.get('/api/accounts/:id/rules', auth, (req, res) => res.json(store.listRules(req.params.id)));

app.post('/api/accounts/:id/rules', auth, (req, res) => {
  const { category, field, keyword } = req.body || {};
  if (!ruleOwnerOk(req.params.id)) return res.status(404).json({ error: '계정을 찾을 수 없습니다.' });
  if (!category || !keyword || !mail.RULE_FIELDS.includes(field)) {
    return res.status(400).json({ error: '분류 이름, 대상(보낸사람/받는사람/제목), 키워드가 필요합니다.' });
  }
  res.json(store.addRule({ accountId: req.params.id, category: category.trim(), field, keyword: keyword.trim() }));
});

app.delete('/api/rules/:id', auth, (req, res) => {
  store.removeRule(req.params.id);
  res.json({ ok: true });
});

if (require.main === module) {
  if (PUBLIC && !process.env.SITE_PASSWORD) {
    console.error('인터넷에 공개할 때는 SITE_PASSWORD 환경변수로 사이트 비밀번호를 꼭 정해야 합니다.');
    process.exit(1);
  }
  store.init().then(() => {
    app.listen(PORT, HOST, () => console.log(`메일 통합 조회: http://${PUBLIC ? 'localhost' : HOST}:${PORT}`));
  }).catch((e) => { console.error('저장소를 열 수 없습니다:', e.message); process.exit(1); });
}

module.exports = app;
