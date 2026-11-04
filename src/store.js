// 계정·분류 규칙·사이트 비밀번호를 저장한다 (Postgres 또는 data/store.json).
// 메일 비밀번호는 AES-256-GCM 으로 암호화해서만 저장한다.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 저장 위치: DATABASE_URL 이 있으면 Postgres(서버 배포용), 없으면 data/store.json(내 PC용).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const KEY_FILE = path.join(DATA_DIR, 'secret.key');
const DATABASE_URL = process.env.DATABASE_URL;

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadKey() {
  if (process.env.MASTER_KEY) {
    // 어떤 문자열이 와도 SHA-256 으로 32바이트 키를 만든다.
    return crypto.createHash('sha256').update(process.env.MASTER_KEY).digest();
  }
  if (DATABASE_URL) throw new Error('DATABASE_URL 을 쓸 때는 MASTER_KEY 환경변수가 꼭 필요합니다.');
  if (!fs.existsSync(KEY_FILE)) {
    fs.writeFileSync(KEY_FILE, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
  }
  return Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'base64');
}
const KEY = loadKey();

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

function decrypt(blob) {
  const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `${salt.toString('base64')}.${hash.toString('base64')}`;
}

function verifyPassword(pw, stored) {
  const [salt, hash] = stored.split('.').map((s) => Buffer.from(s, 'base64'));
  const test = crypto.scryptSync(pw, salt, 64);
  return crypto.timingSafeEqual(test, hash);
}

let state = { passwordHash: null, accounts: [], rules: [], vapid: null, pushSubs: [], seen: {} };
let pool = null;

// 전체 상태를 한 덩어리 JSON 으로 저장한다 (개인용이라 데이터가 작다).
async function init() {
  if (DATABASE_URL) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: DATABASE_URL, ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false }, max: 3 });
    await pool.query('CREATE TABLE IF NOT EXISTS mailhub_state (id int PRIMARY KEY, data jsonb NOT NULL)');
    const r = await pool.query('SELECT data FROM mailhub_state WHERE id = 1');
    if (r.rows[0]) state = { ...state, ...r.rows[0].data };
  } else if (fs.existsSync(STORE_FILE)) {
    state = { ...state, ...JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')) };
  }
}

let saving = Promise.resolve();
function save() {
  const snapshot = JSON.stringify(state);
  saving = saving.then(async () => {
    if (pool) {
      await pool.query('INSERT INTO mailhub_state (id, data) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET data = $1', [snapshot]);
    } else {
      const tmp = STORE_FILE + '.tmp';
      fs.writeFileSync(tmp, snapshot, { mode: 0o600 });
      fs.renameSync(tmp, STORE_FILE);
    }
  }).catch((e) => console.error('저장 실패:', e));
  return saving;
}

const id = () => crypto.randomBytes(8).toString('hex');

// SITE_PASSWORD 환경변수가 있으면 그것이 사이트 비밀번호다 (서버 배포 시 남이 먼저 비밀번호를 정하는 것을 막는다).
const SITE_PASSWORD = process.env.SITE_PASSWORD;
const sitePwHash = SITE_PASSWORD ? hashPassword(SITE_PASSWORD) : null;

module.exports = {
  ALL: '__all', // 전체 메일함의 분류 규칙은 accountId 가 이 값이다.
  init,
  isSetup: () => !!(sitePwHash || state.passwordHash),
  setPassword(pw) { if (sitePwHash) throw new Error('SITE_PASSWORD 로 설정되어 있습니다.'); state.passwordHash = hashPassword(pw); return save(); },
  checkPassword(pw) {
    const h = sitePwHash || state.passwordHash;
    return !!h && verifyPassword(pw, h);
  },

  listAccounts: () => state.accounts.map(({ passEnc, ...a }) => a),
  getAccountWithSecret(accountId) {
    const a = state.accounts.find((x) => x.id === accountId);
    return a ? { ...a, password: decrypt(a.passEnc) } : null;
  },
  addAccount({ provider, email, label, host, port, password }) {
    const a = { id: id(), provider, email, label: label || email, host, port, passEnc: encrypt(password) };
    state.accounts.push(a);
    save();
    const { passEnc, ...pub } = a;
    return pub;
  },
  removeAccount(accountId) {
    state.accounts = state.accounts.filter((a) => a.id !== accountId);
    state.rules = state.rules.filter((r) => r.accountId !== accountId);
    delete state.seen[accountId];
    save();
  },

  listRules: (accountId) => state.rules.filter((r) => r.accountId === accountId),
  addRule({ accountId, category, field, keyword }) {
    const r = { id: id(), accountId, category, field, keyword };
    state.rules.push(r);
    save();
    return r;
  },
  removeRule(ruleId) { state.rules = state.rules.filter((r) => r.id !== ruleId); save(); },

  // ---- 푸시 알림 ----
  // VAPID 키는 처음 한 번 만들어 저장소에 둔다 (개인키는 암호화).
  getVapid(generate) {
    if (!state.vapid) {
      const k = generate();
      state.vapid = { publicKey: k.publicKey, privateEnc: encrypt(k.privateKey) };
      save();
    }
    return { publicKey: state.vapid.publicKey, privateKey: decrypt(state.vapid.privateEnc) };
  },
  listPushSubs: () => state.pushSubs,
  addPushSub(sub) {
    state.pushSubs = state.pushSubs.filter((s) => s.endpoint !== sub.endpoint);
    state.pushSubs.push({ endpoint: sub.endpoint, keys: sub.keys, at: new Date().toISOString() });
    return save();
  },
  removePushSub(endpoint) { state.pushSubs = state.pushSubs.filter((s) => s.endpoint !== endpoint); return save(); },
  hasPushSub: (endpoint) => state.pushSubs.some((s) => s.endpoint === endpoint),
  // 계정별로 어디까지 알림을 보냈는지 (IMAP UIDVALIDITY + 마지막 UID)
  getSeen: (accountId) => state.seen[accountId] || null,
  setSeen(accountId, v) { state.seen[accountId] = v; return save(); },
};
