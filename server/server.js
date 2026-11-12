// 파랑새 우체국: 같은 "둥지 코드"를 쓰는 친구들끼리 쪽지를 전달하는 아주 작은 WebSocket 서버.
// 실행: npm install && npm start   (PORT 환경변수로 포트 변경, 기본 8787)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8787;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const MAX_NOTES_PER_NEST = 500;
const MAX_TEXT = 1000;

// nests: { [nestCode]: { notes: Note[], friends: { [id]: { name, lastSeen } } } }
let nests = {};
try {
  nests = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch {
  nests = {};
}

let saveTimer = null;
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(DATA_FILE, JSON.stringify(nests), (err) => {
      if (err) console.error('저장 실패:', err.message);
    });
  }, 1000);
}

function nestOf(code) {
  if (!nests[code]) nests[code] = { notes: [], friends: {} };
  return nests[code];
}

// 접속 중인 소켓: ws -> { nest, id, name }
const sessions = new Map();

function onlineIds(code) {
  const ids = new Set();
  for (const s of sessions.values()) if (s.nest === code) ids.add(s.id);
  return ids;
}

function rosterOf(code) {
  const nest = nestOf(code);
  const online = onlineIds(code);
  return Object.entries(nest.friends)
    .map(([id, f]) => ({ id, name: f.name, online: online.has(id), lastSeen: f.lastSeen }))
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcastRoster(code) {
  const friends = rosterOf(code);
  for (const [ws, s] of sessions) if (s.nest === code) send(ws, { type: 'roster', friends });
}

const cleanStr = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('🐦 파랑새 우체국이 열려 있어요.\n');
});

const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'hello') {
      const nest = cleanStr(msg.nest, 64);
      const id = cleanStr(msg.id, 64);
      const name = cleanStr(msg.name, 20);
      if (!nest || !id || !name) return send(ws, { type: 'error', message: '둥지 코드와 이름을 확인해 주세요.' });

      sessions.set(ws, { nest, id, name });
      const n = nestOf(nest);
      n.friends[id] = { name, lastSeen: Date.now() };
      saveSoon();

      const since = Number(msg.lastSeen) || 0;
      const backlog = n.notes.filter(
        (x) => x.ts > since && x.from !== id && (x.to === 'all' || x.to === id)
      );
      send(ws, { type: 'welcome', friends: rosterOf(nest), backlog });
      broadcastRoster(nest);
      return;
    }

    const me = sessions.get(ws);
    if (!me) return;

    if (msg.type === 'note') {
      const text = cleanStr(msg.text, MAX_TEXT);
      const to = cleanStr(msg.to, 64) || 'all';
      if (!text) return;
      const n = nestOf(me.nest);
      const note = {
        id: crypto.randomUUID(),
        from: me.id,
        fromName: me.name,
        to,
        toName: to === 'all' ? '모두' : (n.friends[to]?.name || '친구'),
        text,
        color: cleanStr(msg.color, 16) || 'cream',
        ts: Date.now(),
      };
      n.notes.push(note);
      if (n.notes.length > MAX_NOTES_PER_NEST) n.notes.splice(0, n.notes.length - MAX_NOTES_PER_NEST);
      saveSoon();

      for (const [sock, s] of sessions) {
        if (s.nest !== me.nest || s.id === me.id) continue;
        if (to === 'all' || to === s.id) send(sock, { type: 'note', note });
      }
      send(ws, { type: 'sent', note, ref: msg.ref });
    }
  });

  ws.on('close', () => {
    const me = sessions.get(ws);
    sessions.delete(ws);
    if (me) {
      const f = nestOf(me.nest).friends[me.id];
      if (f) f.lastSeen = Date.now();
      saveSoon();
      broadcastRoster(me.nest);
    }
  });
});

// 끊긴 연결 정리 + 무료 호스팅의 유휴 종료 방지
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`🐦 파랑새 우체국 열림: ws://localhost:${PORT}`);
});
