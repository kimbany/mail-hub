// 계정·분류 규칙·사이트 비밀번호를 data/store.json 에 저장한다.
// 메일 비밀번호는 AES-256-GCM 으로 암호화해서만 저장한다.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const KEY_FILE = path.join(DATA_DIR, 'secret.key');

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadKey() {
  if (process.env.MASTER_KEY) {
    const k = Buffer.from(process.env.MASTER_KEY, 'base64');
    if (k.length !== 32) throw new Error('MASTER_KEY 는 base64 로 인코딩한 32바이트여야 합니다.');
    return k;
  }
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

let state = { passwordHash: null, accounts: [], rules: [] };
if (fs.existsSync(STORE_FILE)) state = { ...state, ...JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')) };

function save() {
  const tmp = STORE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STORE_FILE);
}

const id = () => crypto.randomBytes(8).toString('hex');

module.exports = {
  isSetup: () => !!state.passwordHash,
  setPassword(pw) { state.passwordHash = hashPassword(pw); save(); },
  checkPassword: (pw) => !!state.passwordHash && verifyPassword(pw, state.passwordHash),

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
};
