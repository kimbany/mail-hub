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
  if (!state.current && state.accounts[0]) selectAccount(state.accounts[0].id);
  if (!state.accounts.length) { state.current = null; renderEmpty(); }
}

function renderAccounts() {
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
  const acc = state.accounts.find((a) => a.id === id);
  $('#account-title').textContent = `${acc.label} 받은메일`;
  $('#rules-btn').disabled = $('#refresh-btn').disabled = false;
  $('#message-list').innerHTML = '<li class="empty">메일을 불러오는 중…</li>';
  $('#reader').innerHTML = '<p class="muted">메일을 선택하세요.</p>';
  try {
    const list = await api(`/api/accounts/${id}/messages${refresh ? '?refresh=1' : ''}`);
    if (state.current !== id) return;
    state.messages = list;
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
  $('#message-list').innerHTML = shown.length ? shown.map((m) => `
    <li data-uid="${m.uid}" class="${m.seen ? '' : 'unread'}">
      <div class="meta"><span>${esc(m.from)}</span><span>${fmtDate(m.date)}</span></div>
      <div class="subj">${m.category && state.category === '__all' ? `<span class="badge">${esc(m.category)}</span>` : ''}${esc(m.subject)}</div>
    </li>`).join('') : '<li class="empty">메일이 없어요.</li>';
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
    const m = await api(`/api/accounts/${state.current}/messages/${li.dataset.uid}`);
    const hit = state.messages.find((x) => x.uid === m.uid);
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
    <li><span><b>${esc(r.category)}</b> ← ${r.field === 'from' ? '보낸사람' : '제목'}에 "${esc(r.keyword)}" 포함</span>
    <button type="button" data-rule="${r.id}">삭제</button></li>`).join('')
    : '<li class="muted">아직 규칙이 없어요.</li>';
}
$('#rules-btn').onclick = async () => { $('#rule-err').textContent = ''; await loadRules(); ruleDlg.showModal(); };
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
}

(async () => {
  const s = await api('/api/status');
  if (s.loggedIn) startApp(); else showGate(s.setup);
})();
