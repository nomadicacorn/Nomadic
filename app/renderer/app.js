// 쪽지함 창
const PAPER = { cream: '#fffbee', pink: '#ffeef3', mint: '#eafaf1', sky: '#eaf4ff' };
const $ = (id) => document.getElementById(id);

let state = null;
let recipient = 'all';
let color = 'cream';
let pendingRecipient = null;

// ---------- 탭 ----------
function showTab(name) {
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
  if (name === 'compose') setTimeout(() => $('text').focus(), 0);
}
document.querySelectorAll('nav button').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));

// ---------- 렌더링 ----------
function fmtTime(ts) {
  return new Date(ts).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  for (const c of children) if (c != null) e.append(c);
  return e;
}

function noteItem(n, kind) {
  const li = el('li', { className: 'note' + (kind === 'inbox' && !n.read ? ' unread' : '') });
  li.style.setProperty('--paper', PAPER[n.color] || PAPER.cream);
  const who = kind === 'inbox'
    ? el('span', {}, el('b', { textContent: n.fromName }), n.to === 'all' ? ' → 모두' : '')
    : el('span', {}, '→ ', el('b', { textContent: n.toName || '친구' }));
  li.append(
    el('div', { className: 'note-head' }, who, el('span', { textContent: fmtTime(n.ts) })),
    el('div', { className: 'note-text', textContent: n.text }),
  );
  const actions = el('div', { className: 'note-actions' });
  if (kind === 'inbox') {
    if (!n.read) actions.append(el('button', { textContent: '읽음', onclick: () => window.bird.markRead(n.id) }));
    actions.append(
      el('button', { textContent: '🐦 다시 배달', onclick: () => window.bird.replayNote(n.id) }),
      el('button', { textContent: '답장', onclick: () => startCompose({ to: n.from, toName: n.fromName }) }),
    );
  }
  actions.append(el('button', {
    textContent: '지우기',
    onclick: () => { if (confirm('이 쪽지를 지울까요?')) window.bird.deleteNote(n.id); },
  }));
  li.append(actions);
  return li;
}

function renderLists() {
  const inbox = state.inbox || [];
  const sent = state.sent || [];
  $('inboxList').replaceChildren(...inbox.map((n) => noteItem(n, 'inbox')));
  $('sentList').replaceChildren(...sent.map((n) => noteItem(n, 'sent')));
  $('inboxEmpty').hidden = inbox.length > 0;
  $('sentEmpty').hidden = sent.length > 0;
  const unread = inbox.filter((n) => !n.read).length;
  $('unread').hidden = !unread;
  $('unread').textContent = unread;
}

function renderRecipients() {
  const others = (state.friends || []).filter((f) => f.id !== state.me);
  if (recipient !== 'all' && !others.some((f) => f.id === recipient) && !pendingRecipient) recipient = 'all';
  const chips = [el('button', { textContent: '👥 모두에게', className: recipient === 'all' ? 'active' : '', onclick: () => pick('all') })];
  for (const f of others) {
    chips.push(el('button', {
      className: recipient === f.id ? 'active' : '',
      title: f.online ? '지금 접속 중' : '오프라인 (다음에 켤 때 배달돼요)',
      onclick: () => pick(f.id),
    }, el('span', { className: 'dot ' + (f.online ? 'on' : 'off'), textContent: '●' }), f.name));
  }
  // 아직 친구 목록에 없는 사람에게 답장하는 경우
  if (pendingRecipient && !others.some((f) => f.id === pendingRecipient.to)) {
    chips.push(el('button', { className: 'active', textContent: pendingRecipient.toName }));
  }
  $('recipients').replaceChildren(...chips);
}

function pick(id) {
  recipient = id;
  pendingRecipient = null;
  renderRecipients();
}

function renderHeader() {
  const s = state.settings;
  const labels = { online: '연결됨', connecting: '연결 중…', offline: '연결 끊김', error: '오류' };
  $('status').className = 'status ' + state.conn;
  $('status').textContent = labels[state.conn] || state.conn;
  $('status').title = state.connError || '';
  const online = (state.friends || []).filter((f) => f.online && f.id !== state.me).length;
  $('who').textContent = s.name
    ? `${s.name} · 둥지 "${s.nest}" · 접속 중인 친구 ${online}명`
    : '설정에서 이름과 둥지 코드를 입력해 주세요';
}

function render() {
  if (!state) return;
  renderHeader();
  renderLists();
  renderRecipients();
}

// ---------- 쪽지 쓰기 ----------

function startCompose(c) {
  if (c && c.to) {
    recipient = c.to;
    pendingRecipient = c.to === 'all' ? null : c;
  }
  render();
  showTab('compose');
}

$('text').addEventListener('input', () => { $('count').textContent = `${$('text').value.length} / 1000`; });
$('text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.ctrlKey) send(); });
document.querySelectorAll('#colors button').forEach((b) => {
  b.onclick = () => {
    color = b.dataset.color;
    document.querySelectorAll('#colors button').forEach((x) => x.classList.toggle('active', x === b));
  };
});

async function send() {
  const text = $('text').value.trim();
  const msg = $('sendMsg');
  if (!text) { msg.className = 'msg err'; msg.textContent = '쪽지 내용을 적어 주세요.'; return; }
  $('sendBtn').disabled = true;
  msg.className = 'msg';
  msg.textContent = '파랑새가 쪽지를 물고 있어요…';
  const res = await window.bird.sendNote({ to: recipient, text, color });
  $('sendBtn').disabled = false;
  if (res.ok) {
    $('text').value = '';
    $('count').textContent = '0 / 1000';
    msg.className = 'msg ok';
    msg.textContent = '🐦 파랑새가 날아갔어요!';
    pendingRecipient = null;
  } else {
    msg.className = 'msg err';
    msg.textContent = res.error;
  }
}
$('sendBtn').onclick = send;

// ---------- 설정 ----------
function fillSettings() {
  const s = state.settings;
  $('name').value = s.name || '';
  $('nest').value = s.nest || '';
  $('serverUrl').value = s.serverUrl || '';
  $('autoStart').checked = !!s.autoStart;
  $('sound').checked = s.sound !== false;
}

$('settingsForm').onsubmit = async (e) => {
  e.preventDefault();
  let url = $('serverUrl').value.trim();
  if (url && !/^wss?:\/\//i.test(url)) {
    url = (/^https:/i.test(url) ? url.replace(/^https:/i, 'wss:') : 'ws://' + url.replace(/^http:\/\//i, ''));
    $('serverUrl').value = url;
  }
  state = await window.bird.saveSettings({
    name: $('name').value,
    nest: $('nest').value,
    serverUrl: url,
    autoStart: $('autoStart').checked,
    sound: $('sound').checked,
  });
  render();
  $('settingsMsg').className = 'msg ok';
  $('settingsMsg').textContent = '저장했어요. 우체국에 연결하는 중…';
  setTimeout(() => showTab('inbox'), 900);
};

// ---------- 시작 ----------
window.bird.onState((s) => { state = s; render(); });
window.bird.onCompose((c) => {
  if (c.setup) { fillSettings(); showTab('settings'); return; }
  startCompose(c);
});
window.bird.getState().then((s) => {
  state = s;
  fillSettings();
  render();
});
