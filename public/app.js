const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const HELP = {
  gmail: 'Gmail: Google 계정 → 보안 → 2단계 인증을 켠 뒤 "앱 비밀번호"를 만들어 넣으세요. (일반 비밀번호로는 안 돼요)',
  naver: '네이버: 메일 → 환경설정 → POP3/IMAP 설정에서 IMAP 사용을 켜세요. 2단계 인증 중이면 네이버 보안설정에서 "애플리케이션 비밀번호"를 만들어 넣으세요.',
  daum: '다음: 메일 → 환경설정 → IMAP/POP3에서 IMAP 사용을 켜세요. 2단계 인증 중이면 앱 비밀번호가 필요해요.',
  kakao: '카카오메일: 메일 → 환경설정 → IMAP/SMTP에서 사용을 켜고, 안내되는 앱 비밀번호를 넣으세요.',
  nate: '네이트: 메일 → 환경설정 → POP3/SMTP/IMAP 설정에서 IMAP 사용을 켜세요.',
  custom: '그 밖의 메일: IMAP 서버 주소와 포트(보통 993)를 직접 입력하세요.',
};

const ALL = '__all'; // 전체 메일함
const FIELD_NAME = { from: '보낸사람', to: '받는사람', subject: '제목' };
const state = { providers: {}, accounts: [], current: null, messages: [], category: '__all', rules: [] };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') { showGate(true); throw new Error(data.error); }
  if (!res.ok) throw new Error(data.error || `오류 (${res.status})`);
  return data;
}

// ---------- 로그인 ----------
let setupMode = false;
function showGate(setup) {
  $('#app').classList.add('hidden');
  $('#gate').classList.remove('hidden');
  setupMode = !setup;
  $('#gate-msg').textContent = setupMode
    ? '처음 사용하시네요. 이 사이트에 들어올 때 쓸 비밀번호를 정하세요 (8자 이상).'
    : '사이트 비밀번호를 입력하세요.';
  $('#gate-btn').textContent = setupMode ? '비밀번호 설정' : '로그인';
  $('#gate-pw').value = '';
  $('#gate-pw').focus();
}

$('#gate-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#gate-err').textContent = '';
  try {
    await api(setupMode ? '/api/setup' : '/api/login', { method: 'POST', body: { password: $('#gate-pw').value } });
    startApp();
  } catch (err) { $('#gate-err').textContent = err.message; }
});

$('#logout-btn').onclick = async () => { await api('/api/logout', { method: 'POST' }); showGate(true); };

// ---------- 계정 ----------
async function loadAccounts() {
  state.accounts = await api('/api/accounts');
  renderAccounts();
  // 알림을 눌러 들어온 경우 (?account=…) 그 계정을 연다.
  const want = new URLSearchParams(location.search).get('account');
  if (want && state.accounts.some((a) => a.id === want)) { history.replaceState(null, '', '/'); selectAccount(want); return; }
  if (!state.current && state.accounts.length) selectAccount(state.accounts.length > 1 ? ALL : state.accounts[0].id);
  if (!state.accounts.length) { state.current = null; renderEmpty(); }
}

function renderAccounts() {
  $('#all-box').classList.toggle('hidden', !state.accounts.length);
  $('#all-box li').classList.toggle('active', state.current === ALL);
  const ul = $('#account-list');
  ul.innerHTML = state.accounts.map((a) => `
    <li data-id="${a.id}" class="${state.current === a.id ? 'active' : ''}">
      <div class="acc-name"><span class="badge">${esc(state.providers[a.provider]?.name || '기타')}</span>${esc(a.label)}
        <span class="acc-sub">${esc(a.email)}</span></div>
      <button class="del" title="연결 해제" data-del="${a.id}">✕</button>
    </li>`).join('');
}

$('#account-list').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    const acc = state.accounts.find((a) => a.id === del.dataset.del);
    if (!confirm(`${acc.email} 계정 연결을 해제할까요? 이 계정의 분류 규칙도 함께 지워져요.`)) return;
    await api(`/api/accounts/${acc.id}`, { method: 'DELETE' });
    if (state.current === acc.id) state.current = null;
    return loadAccounts();
  }
  const li = e.target.closest('li[data-id]');
  if (li) selectAccount(li.dataset.id);
});
$('#all-box').addEventListener('click', () => selectAccount(ALL));
const accLabel = (id) => state.accounts.find((a) => a.id === id)?.label || '';

function renderEmpty() {
  $('#account-title').textContent = '계정을 추가하세요';
  $('#category-tabs').innerHTML = '';
  $('#message-list').innerHTML = '<li class="empty">왼쪽 "+ 계정 추가"로 메일 계정을 연결하세요.</li>';
  $('#reader').innerHTML = '';
  $('#rules-btn').disabled = $('#refresh-btn').disabled = true;
}

async function selectAccount(id, refresh = false) {
  state.current = id;
  state.category = refresh ? state.category : '__all';
  renderAccounts();
  const all = id === ALL;
  $('#account-title').textContent = all ? '전체 메일함' : `${accLabel(id)} 받은메일`;
  $('#rules-btn').disabled = $('#refresh-btn').disabled = false;
  $('#message-list').innerHTML = '<li class="empty">메일을 불러오는 중…</li>';
  $('#reader').innerHTML = '<p class="muted">메일을 선택하세요.</p>';
  try {
    const q = refresh ? '?refresh=1' : '';
    const data = all ? await api(`/api/all/messages${q}`) : { messages: await api(`/api/accounts/${id}/messages${q}`), errors: [] };
    if (state.current !== id) return;
    state.messages = data.messages;
    state.errors = data.errors;
    renderMessages();
  } catch (err) {
    $('#message-list').innerHTML = `<li class="empty error">${esc(err.message)}</li>`;
  }
}

$('#refresh-btn').onclick = () => state.current && selectAccount(state.current, true);

// ---------- 분류 탭 + 목록 ----------
function renderMessages() {
  const counts = {};
  let none = 0;
  for (const m of state.messages) m.category ? (counts[m.category] = (counts[m.category] || 0) + 1) : none++;
  const tabs = [['__all', `전체 ${state.messages.length}`], ...Object.entries(counts).map(([c, n]) => [c, `${c} ${n}`])];
  if (Object.keys(counts).length) tabs.push(['__none', `미분류 ${none}`]);
  $('#category-tabs').innerHTML = tabs.map(([k, t]) =>
    `<button data-cat="${esc(k)}" class="${state.category === k ? 'active' : ''}">${esc(t)}</button>`).join('');

  const shown = state.messages.filter((m) =>
    state.category === '__all' || (state.category === '__none' ? !m.category : m.category === state.category));
  const all = state.current === ALL;
  const warn = (state.errors || []).map((e) => `<li class="empty list-warn">⚠ ${esc(e.label)}: ${esc(e.error)}</li>`).join('');
  $('#message-list').innerHTML = warn + (shown.length ? shown.map((m) => `
    <li data-acc="${m.accountId}" data-uid="${m.uid}" class="${m.seen ? '' : 'unread'}">
      <div class="meta"><span>${all ? `<span class="badge acc">${esc(accLabel(m.accountId))}</span>` : ''}${esc(m.from)}</span><span>${fmtDate(m.date)}</span></div>
      <div class="subj">${m.category && state.category === '__all' ? `<span class="badge">${esc(m.category)}</span>` : ''}${esc(m.subject)}</div>
    </li>`).join('') : '<li class="empty">메일이 없어요.</li>');
}

$('#category-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cat]');
  if (!b) return;
  state.category = b.dataset.cat;
  renderMessages();
});

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d), now = new Date();
  return dt.toDateString() === now.toDateString()
    ? dt.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
    : dt.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
}

// ---------- 본문 ----------
$('#message-list').addEventListener('click', async (e) => {
  const li = e.target.closest('li[data-uid]');
  if (!li) return;
  document.querySelectorAll('#message-list li.active').forEach((x) => x.classList.remove('active'));
  li.classList.add('active', 'seen');
  li.classList.remove('unread');
  const reader = $('#reader');
  reader.innerHTML = '<p class="muted">불러오는 중…</p>';
  try {
    const m = await api(`/api/accounts/${li.dataset.acc}/messages/${li.dataset.uid}`);
    const hit = state.messages.find((x) => x.uid === m.uid && x.accountId === li.dataset.acc);
    if (hit) hit.seen = true;
    reader.innerHTML = `
      <h3>${esc(m.subject)}</h3>
      <div class="hdr">보낸사람: ${esc(m.from)}<br>받는사람: ${esc(m.to)}<br>${esc(new Date(m.date).toLocaleString('ko-KR'))}
      ${m.attachments.length ? `<br>첨부: ${m.attachments.map((a) => esc(a.filename)).join(', ')}` : ''}</div>`;
    if (m.html) {
      // 메일 HTML 은 스크립트가 실행되지 않는 sandbox iframe 안에서만 보여준다.
      const f = document.createElement('iframe');
      f.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
      f.srcdoc = `<base target="_blank">${m.html}`;
      reader.appendChild(f);
    } else {
      const pre = document.createElement('pre');
      pre.textContent = m.text;
      reader.appendChild(pre);
    }
  } catch (err) { reader.innerHTML = `<p class="error">${esc(err.message)}</p>`; }
});

// ---------- 계정 추가 대화상자 ----------
const accDlg = $('#account-dialog');
function updateProviderUI() {
  const p = $('#provider-select').value;
  $('#custom-server').classList.toggle('hidden', p !== 'custom');
  $('#provider-help').textContent = HELP[p] || '';
}
$('#provider-select').onchange = updateProviderUI;
$('#add-account-btn').onclick = () => {
  $('#account-form').reset();
  $('#account-err').textContent = '';
  updateProviderUI();
  accDlg.showModal();
};
$('#account-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  $('#account-err').textContent = '';
  $('#account-save').disabled = true;
  $('#account-save').textContent = '연결 확인 중…';
  try {
    const acc = await api('/api/accounts', { method: 'POST', body });
    accDlg.close();
    state.current = null;
    await loadAccounts();
    selectAccount(acc.id);
  } catch (err) {
    $('#account-err').textContent = err.message;
  } finally {
    $('#account-save').disabled = false;
    $('#account-save').textContent = '연결 확인 후 추가';
  }
});

// ---------- 분류 규칙 대화상자 ----------
const ruleDlg = $('#rules-dialog');
async function loadRules() {
  state.rules = await api(`/api/accounts/${state.current}/rules`);
  $('#rule-list').innerHTML = state.rules.length ? state.rules.map((r) => `
    <li><span><b>${esc(r.category)}</b> ← ${FIELD_NAME[r.field] || r.field}에 "${esc(r.keyword)}" 포함</span>
    <button type="button" data-rule="${r.id}">삭제</button></li>`).join('')
    : '<li class="muted">아직 규칙이 없어요.</li>';
}
$('#rules-btn').onclick = async () => {
  $('#rule-err').textContent = '';
  const all = state.current === ALL;
  $('#rules-title').textContent = all ? '전체 메일함 분류 규칙' : `${accLabel(state.current)} 분류 규칙`;
  $('#rules-scope').textContent = all
    ? '전체 메일함에서 쓰는 분류예요. 모든 계정의 메일에 적용돼요. (계정별 분류와는 따로 관리돼요)'
    : '이 계정 메일함에서만 쓰는 분류예요. 모든 계정에 걸친 분류는 "전체 메일함"에서 만드세요.'; await loadRules(); ruleDlg.showModal(); };
$('#rule-list').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-rule]');
  if (!b) return;
  await api(`/api/rules/${b.dataset.rule}`, { method: 'DELETE' });
  await loadRules();
});
$('#rule-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#rule-err').textContent = '';
  try {
    await api(`/api/accounts/${state.current}/rules`, { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
    e.target.category.value = e.target.keyword.value = '';
    await loadRules();
  } catch (err) { $('#rule-err').textContent = err.message; }
});
ruleDlg.addEventListener('close', () => state.current && selectAccount(state.current));

document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => b.closest('dialog').close()));

// ---------- 시작 ----------
async function startApp() {
  $('#gate').classList.add('hidden');
  $('#app').classList.remove('hidden');
  state.providers = await api('/api/providers');
  $('#provider-select').innerHTML =
    Object.entries(state.providers).map(([k, p]) => `<option value="${k}">${esc(p.name)}</option>`).join('') +
    '<option value="custom">기타 (직접 입력)</option>';
  await loadAccounts();
  initPush();
}

// ---------- 새 메일 푸시 알림 ----------
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;

function b64ToBytes(b64) {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function pushSubscription() {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

function setPushUI(on, msg = '') {
  $('#push-btn').textContent = on ? '🔕 새 메일 알림 끄기' : '🔔 새 메일 알림 켜기';
  $('#push-btn').dataset.on = on ? '1' : '';
  $('#push-test-btn').classList.toggle('hidden', !on);
  $('#push-msg').textContent = msg;
}

async function initPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    $('#push-btn').disabled = true;
    setPushUI(false, isIOS && !standalone
      ? '아이폰은 Safari 공유 버튼 → "홈 화면에 추가"로 설치한 뒤, 홈 화면 아이콘으로 열어야 알림을 켤 수 있어요.'
      : '이 브라우저는 알림을 지원하지 않아요.');
    return;
  }
  await navigator.serviceWorker.register('sw.js');
  const sub = await pushSubscription();
  let on = false;
  if (sub && Notification.permission === 'granted') {
    on = (await api('/api/push/status', { method: 'POST', body: { endpoint: sub.endpoint } })).subscribed;
    if (!on) { await api('/api/push/subscribe', { method: 'POST', body: sub.toJSON() }); on = true; } // 서버 쪽 기록이 사라졌으면 다시 등록
  }
  setPushUI(on, on ? '이 기기로 새 메일 알림이 와요.' : '');
}

$('#push-btn').onclick = async () => {
  const btn = $('#push-btn');
  btn.disabled = true;
  try {
    if (btn.dataset.on) {
      const sub = await pushSubscription();
      if (sub) {
        await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } });
        await sub.unsubscribe();
      }
      setPushUI(false, '이 기기의 알림을 껐어요.');
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      setPushUI(false, '알림 권한이 거부됐어요. 폰 설정에서 이 앱의 알림을 허용해 주세요.');
      return;
    }
    const { publicKey } = await api('/api/push/key');
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription())
      || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) }));
    await api('/api/push/subscribe', { method: 'POST', body: sub.toJSON() });
    setPushUI(true, '알림을 켰어요. 지금 이후로 오는 새 메일부터 알려 드려요.');
  } catch (err) {
    setPushUI(false, `알림을 켜지 못했어요: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
};

$('#push-test-btn').onclick = async () => {
  try {
    const r = await api('/api/push/test', { method: 'POST' });
    $('#push-msg').textContent = r.sent ? '테스트 알림을 보냈어요.' : '보낼 기기가 없어요. 알림을 다시 켜 주세요.';
  } catch (err) { $('#push-msg').textContent = err.message; }
};

(async () => {
  const s = await api('/api/status');
  if (s.loggedIn) startApp(); else showGate(s.setup);
})();
