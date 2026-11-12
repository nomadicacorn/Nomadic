// 파랑새 쪽지 - Electron 메인 프로세스
// - 트레이에 상주하며 우체국 서버(WebSocket)에 연결
// - 쪽지가 오면 투명 오버레이 창에서 파랑새가 날아와 쪽지를 전달
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const WebSocket = require('ws');

// 한 PC에서 여러 명을 테스트할 때: BLUEBIRD_PROFILE=폴더경로 로 실행하면 따로 저장됨
if (process.env.BLUEBIRD_PROFILE) app.setPath('userData', path.resolve(process.env.BLUEBIRD_PROFILE));

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
if (process.platform === 'win32') app.setAppUserModelId('com.nomadic.bluebirdnotes');

const ASSETS = path.join(__dirname, 'assets');
const MAX_BIRDS_AT_ONCE = 5;

// ---------- 저장소 ----------
const dataDir = () => app.getPath('userData');
function readJson(file, fallback) {
  try { return { ...fallback, ...JSON.parse(fs.readFileSync(path.join(dataDir(), file), 'utf8')) }; }
  catch { return fallback; }
}
function writeJson(file, obj) {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(path.join(dataDir(), file), JSON.stringify(obj, null, 2));
}

let settings;
let store; // { inbox: Note[], sent: Note[] }
const saveSettings = () => writeJson('settings.json', settings);
const saveStore = () => writeJson('notes.json', store);

// ---------- 상태 ----------
let friends = [];
let conn = 'offline'; // offline | connecting | online | error
let connError = '';
let ws = null;
let retryMs = 1000;
let retryTimer = null;
const pendingAcks = new Map(); // ref -> { resolve, timer }

function publicState() {
  return {
    settings: { ...settings },
    me: settings.clientId,
    conn,
    connError,
    friends,
    inbox: store.inbox,
    sent: store.sent,
  };
}

function pushState() {
  const st = publicState();
  for (const w of [mainWin, overlayWin]) if (w && !w.isDestroyed()) w.webContents.send('state', st);
  updateTray();
}

// ---------- 서버 연결 ----------
function connect() {
  clearTimeout(retryTimer);
  if (ws) { ws.removeAllListeners(); try { ws.terminate(); } catch {} ws = null; }
  if (!settings.serverUrl || !settings.nest || !settings.name) {
    conn = 'offline';
    connError = '설정에서 우체국 주소, 둥지 코드, 이름을 입력해 주세요.';
    return pushState();
  }

  conn = 'connecting';
  connError = '';
  pushState();

  let sock;
  try {
    sock = new WebSocket(settings.serverUrl, { handshakeTimeout: 10000 });
  } catch (e) {
    conn = 'error';
    connError = '우체국 주소가 올바르지 않아요: ' + e.message;
    return pushState();
  }
  ws = sock;

  sock.on('open', () => {
    retryMs = 1000;
    sock.send(JSON.stringify({
      type: 'hello',
      nest: settings.nest,
      id: settings.clientId,
      name: settings.name,
      lastSeen: settings.lastSeen || 0,
    }));
  });

  sock.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.type) {
      case 'welcome':
        conn = 'online';
        friends = msg.friends || [];
        receiveNotes(msg.backlog || []);
        pushState();
        break;
      case 'roster':
        friends = msg.friends || [];
        pushState();
        break;
      case 'note':
        receiveNotes([msg.note]);
        break;
      case 'sent': {
        const p = pendingAcks.get(msg.ref);
        if (p) { clearTimeout(p.timer); pendingAcks.delete(msg.ref); p.resolve(msg.note); }
        break;
      }
      case 'error':
        connError = msg.message || '오류';
        pushState();
        break;
    }
  });

  sock.on('close', () => {
    if (ws !== sock) return;
    ws = null;
    conn = 'offline';
    friends = friends.map((f) => ({ ...f, online: false }));
    pushState();
    retryTimer = setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 30000);
  });

  sock.on('error', (e) => {
    connError = '우체국에 연결할 수 없어요 (' + (e.code || e.message) + ')';
  });
}

function receiveNotes(notes) {
  const known = new Set(store.inbox.map((n) => n.id));
  const fresh = notes.filter((n) => n && !known.has(n.id));
  if (!fresh.length) return;
  fresh.sort((a, b) => a.ts - b.ts);
  for (const n of fresh) {
    store.inbox.unshift({ ...n, read: false });
    settings.lastSeen = Math.max(settings.lastSeen || 0, n.ts);
  }
  store.inbox = store.inbox.slice(0, 1000);
  saveStore();
  saveSettings();
  pushState();
  // 너무 많이 밀려 있으면 최근 몇 통만 새가 직접 배달
  for (const n of fresh.slice(-MAX_BIRDS_AT_ONCE)) fly({ kind: 'in', note: n });
}

function sendNote({ to, text, color }) {
  return new Promise((resolve) => {
    if (!ws || conn !== 'online') return resolve({ ok: false, error: '우체국에 연결되어 있지 않아요.' });
    const ref = crypto.randomUUID();
    const timer = setTimeout(() => {
      pendingAcks.delete(ref);
      resolve({ ok: false, error: '파랑새가 길을 잃었어요. 다시 보내 주세요.' });
    }, 8000);
    pendingAcks.set(ref, {
      timer,
      resolve: (note) => {
        store.sent.unshift(note);
        store.sent = store.sent.slice(0, 500);
        saveStore();
        pushState();
        fly({ kind: 'out', note });
        resolve({ ok: true });
      },
    });
    ws.send(JSON.stringify({ type: 'note', to, text, color, ref }));
  });
}

// ---------- 파랑새 오버레이 ----------
let overlayWin = null;
let flightsSent = 0;
let overlayReady = false;
const earlyFlights = [];

function createOverlay() {
  const { workArea } = screen.getPrimaryDisplay();
  overlayWin = new BrowserWindow({
    ...workArea,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false,
    },
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setVisibleOnAllWorkspaces(true);
  overlayWin.setIgnoreMouseEvents(true, { forward: true });
  overlayWin.loadFile(path.join(__dirname, 'renderer', 'bird.html'));
  overlayWin.webContents.on('did-finish-load', () => {
    overlayReady = true;
    overlayWin.webContents.send('state', publicState());
    while (earlyFlights.length) fly(earlyFlights.shift());
  });
}

function fly(flight) {
  if (!overlayWin || overlayWin.isDestroyed()) createOverlay();
  if (!overlayReady) return earlyFlights.push(flight);
  // 화면 해상도가 바뀌었을 수 있으니 매번 맞춰 줌
  overlayWin.setBounds(screen.getPrimaryDisplay().workArea);
  flightsSent += 1;
  overlayWin.showInactive();
  overlayWin.webContents.send('fly', flight);
}

ipcMain.on('overlay:clickable', (_e, v) => {
  if (overlayWin) overlayWin.setIgnoreMouseEvents(!v, { forward: true });
});
ipcMain.on('overlay:done', (_e, completed) => {
  if (overlayWin && completed >= flightsSent) {
    overlayWin.setIgnoreMouseEvents(true, { forward: true });
    overlayWin.hide();
  }
});

// ---------- 메인 창 (쪽지함) ----------
let mainWin = null;

function showMain(composeFor) {
  if (!mainWin || mainWin.isDestroyed()) {
    mainWin = new BrowserWindow({
      width: 440,
      height: 680,
      minWidth: 360,
      minHeight: 480,
      title: '파랑새 쪽지',
      icon: path.join(ASSETS, 'icon.png'),
      autoHideMenuBar: true,
      backgroundColor: '#eaf4ff',
      show: false,
      webPreferences: { preload: path.join(__dirname, 'preload.js') },
    });
    mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    mainWin.once('ready-to-show', () => {
      mainWin.show();
      if (composeFor) mainWin.webContents.send('compose', composeFor);
    });
    mainWin.on('close', (e) => {
      if (!app.isQuitting) { e.preventDefault(); mainWin.hide(); }
    });
    return;
  }
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
  if (composeFor) mainWin.webContents.send('compose', composeFor);
}

// ---------- 트레이 ----------
let tray = null;

function updateTray() {
  if (!tray) return;
  const unread = store.inbox.filter((n) => !n.read).length;
  const status = { online: '연결됨', connecting: '연결 중…', offline: '연결 끊김', error: '오류' }[conn];
  tray.setToolTip(`파랑새 쪽지 · ${status}` + (unread ? ` · 안 읽은 쪽지 ${unread}통` : ''));
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(ASSETS, 'tray.png')));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '✉️ 쪽지 쓰기', click: () => showMain({ to: 'all' }) },
    { label: '📬 쪽지함 열기', click: () => showMain() },
    { type: 'separator' },
    { label: '🔄 다시 연결', click: () => { retryMs = 1000; connect(); } },
    { type: 'separator' },
    { label: '종료', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', () => showMain());
  updateTray();
}

// ---------- IPC ----------
ipcMain.handle('state:get', () => publicState());

ipcMain.handle('settings:save', (_e, s) => {
  const prev = { ...settings };
  settings.serverUrl = String(s.serverUrl || '').trim();
  settings.nest = String(s.nest || '').trim();
  settings.name = String(s.name || '').trim().slice(0, 20);
  settings.autoStart = !!s.autoStart;
  settings.sound = s.sound !== false;
  if (prev.nest !== settings.nest || prev.serverUrl !== settings.serverUrl) settings.lastSeen = 0;
  saveSettings();
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: settings.autoStart });
  retryMs = 1000;
  connect();
  return publicState();
});

ipcMain.handle('note:send', (_e, n) => {
  const text = String(n?.text || '').trim();
  if (!text) return { ok: false, error: '쪽지 내용을 적어 주세요.' };
  return sendNote({ to: n.to || 'all', text: text.slice(0, 1000), color: n.color });
});

ipcMain.handle('note:read', (_e, id) => {
  const n = store.inbox.find((x) => x.id === id);
  if (n && !n.read) { n.read = true; saveStore(); pushState(); }
});

ipcMain.handle('note:replay', (_e, id) => {
  const n = store.inbox.find((x) => x.id === id);
  if (n) fly({ kind: 'in', note: n, replay: true });
});

ipcMain.handle('note:delete', (_e, id) => {
  store.inbox = store.inbox.filter((x) => x.id !== id);
  store.sent = store.sent.filter((x) => x.id !== id);
  saveStore();
  pushState();
});

ipcMain.on('note:reply', (_e, note) => {
  showMain({ to: note.from, toName: note.fromName });
});

// ---------- 시작 ----------
app.on('second-instance', () => showMain());
app.on('window-all-closed', (e) => e.preventDefault()); // 트레이에 계속 상주

app.whenReady().then(() => {
  settings = readJson('settings.json', {
    serverUrl: 'ws://localhost:8787',
    nest: '',
    name: '',
    clientId: '',
    lastSeen: 0,
    autoStart: true,
    sound: true,
  });
  if (!settings.clientId) settings.clientId = crypto.randomUUID();
  saveSettings();
  store = readJson('notes.json', { inbox: [], sent: [] });
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!settings.autoStart });

  createTray();
  createOverlay();
  connect();

  // 처음 실행이면 설정 화면부터
  if (!settings.nest || !settings.name) showMain({ setup: true });
});
