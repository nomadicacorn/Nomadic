// 투명 오버레이 위에서 파랑새를 날리는 스크립트
const PAPER = { cream: '#fffbee', pink: '#ffeef3', mint: '#eafaf1', sky: '#eaf4ff' };
const FLY_FRAMES = ['1', '2', '3', '2'];

const $ = (id) => document.getElementById(id);
const birdEl = $('bird');
const img = $('birdImg');
const bubble = $('bubble');
const letter = $('letter');

let state = null;
window.bird.onState((s) => { state = s; });
window.bird.getState().then((s) => { state = s; });

// ---------- 날갯짓 ----------
let frameTimer = null;
function flap(withLetter, speed = 90) {
  clearInterval(frameTimer);
  const prefix = withLetter ? 'bird-' : 'bird-empty-';
  let i = 0;
  const tick = () => { img.src = `../assets/${prefix}${FLY_FRAMES[i++ % FLY_FRAMES.length]}.png`; };
  tick();
  frameTimer = setInterval(tick, speed);
}
function perch() {
  // 기다리는 동안은 천천히 날갯짓 + 가끔 눈 깜빡
  clearInterval(frameTimer);
  let t = 0;
  frameTimer = setInterval(() => {
    t += 1;
    if (t % 24 === 0) img.src = '../assets/bird-blink.png';
    else img.src = `../assets/bird-${FLY_FRAMES[t % FLY_FRAMES.length]}.png`;
  }, 160);
}
// 이미지 미리 로드
for (const p of ['bird-', 'bird-empty-']) for (const f of ['1', '2', '3']) new Image().src = `../assets/${p}${f}.png`;
new Image().src = '../assets/bird-blink.png';

// ---------- 이동 ----------
let pos = { x: -300, y: 0 };
function place(x, y, tilt = 0) {
  pos = { x, y };
  birdEl.style.transform = `translate(${x}px, ${y}px) rotate(${tilt}deg)`;
}

const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

function flyTo(tx, ty, ms, wave = 40) {
  const sx = pos.x, sy = pos.y;
  // 살짝 휘어진 비행 경로 (2차 베지어) + 위아래 물결
  const cx = (sx + tx) / 2;
  const cy = Math.min(sy, ty) - 120;
  return new Promise((resolve) => {
    const t0 = performance.now();
    function step(now) {
      const t = Math.min(1, (now - t0) / ms);
      const e = ease(t);
      const x = (1 - e) * (1 - e) * sx + 2 * (1 - e) * e * cx + e * e * tx;
      const y = (1 - e) * (1 - e) * sy + 2 * (1 - e) * e * cy + e * e * ty
        + Math.sin(t * Math.PI * 5) * wave * (1 - t);
      const dy = Math.cos(t * Math.PI * 5) * wave * (1 - t);
      place(x, y, Math.max(-12, Math.min(12, dy / 6)));
      if (t < 1) requestAnimationFrame(step);
      else resolve();
    }
    requestAnimationFrame(step);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 소리 (짹짹) ----------
let audio = null;
function chirp() {
  if (state && state.settings && state.settings.sound === false) return;
  try {
    audio = audio || new AudioContext();
    const now = audio.currentTime;
    for (const [start, f0, f1] of [[0, 2600, 3900], [0.16, 2900, 4300]]) {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(f0, now + start);
      o.frequency.exponentialRampToValueAtTime(f1, now + start + 0.09);
      g.gain.setValueAtTime(0.0001, now + start);
      g.gain.exponentialRampToValueAtTime(0.18, now + start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + start + 0.11);
      o.connect(g).connect(audio.destination);
      o.start(now + start);
      o.stop(now + start + 0.12);
    }
  } catch { /* 소리는 없어도 괜찮아요 */ }
}

// ---------- 클릭 통과 처리 ----------
// 창 전체는 투명 + 클릭 통과, 마우스가 새/편지 위에 있을 때만 클릭을 받음
let clickable = false;
window.addEventListener('mousemove', (e) => {
  const over = !!(e.target && e.target.closest && e.target.closest('.interactive:not([hidden])'));
  if (over !== clickable) {
    clickable = over;
    window.bird.setClickable(over);
  }
});
function releaseMouse() {
  if (clickable) { clickable = false; window.bird.setClickable(false); }
}

// ---------- 말풍선 ----------
function say(html) {
  bubble.innerHTML = '';
  if (html) {
    const [main, sub] = html;
    bubble.append(document.createTextNode(main));
    if (sub) { const s = document.createElement('small'); s.textContent = sub; bubble.append(s); }
    bubble.classList.add('show');
  } else {
    bubble.classList.remove('show');
  }
}

// ---------- 비행 시나리오 ----------
function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function waitForClick() {
  return new Promise((resolve) => {
    birdEl.addEventListener('click', () => resolve('open'), { once: true });
  });
}

function openLetter(note) {
  return new Promise((resolve) => {
    letter.style.setProperty('--paper', PAPER[note.color] || PAPER.cream);
    $('letterFrom').textContent = `${note.fromName} 님이` + (note.to === 'all' ? ' 모두에게' : '');
    $('letterTime').textContent = fmtTime(note.ts);
    $('letterText').textContent = note.text;

    const W = window.innerWidth;
    const H = window.innerHeight;
    const left = Math.max(12, Math.min(W - 332, pos.x - 300));
    letter.hidden = false;
    const top = Math.max(12, Math.min(H - letter.offsetHeight - 12, pos.y - letter.offsetHeight + 60));
    letter.style.left = left + 'px';
    letter.style.top = top + 'px';

    const done = (action) => {
      letter.hidden = true;
      $('btnReply').onclick = $('btnThanks').onclick = null;
      resolve(action);
    };
    $('btnReply').onclick = () => done('reply');
    $('btnThanks').onclick = () => done('thanks');
  });
}

async function deliver(note, replay) {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const landX = W - 230;
  const landY = H - 190;

  birdEl.classList.remove('flip', 'waiting');
  place(-200, H * (0.15 + Math.random() * 0.25));
  birdEl.hidden = false;
  flap(true);
  await flyTo(landX, landY, 3200, 45);

  place(landX, landY, 0);
  birdEl.classList.add('waiting');
  perch();
  if (!replay) chirp();
  say([`💌 ${note.fromName} 님의 쪽지!`, '눌러서 열어 보기']);

  await waitForClick();
  say(null);
  birdEl.classList.remove('waiting');
  window.bird.markRead(note.id);
  const action = await openLetter(note);
  releaseMouse();
  if (action === 'reply') window.bird.reply(note);

  // 쪽지를 놓고 빈 몸으로 날아감
  say(['💙', null]);
  flap(false, 80);
  await sleep(350);
  say(null);
  await flyTo(W + 220, -220, 1800, 25);
  birdEl.hidden = true;
}

async function departure(note) {
  const W = window.innerWidth;
  const H = window.innerHeight;
  birdEl.classList.remove('waiting');
  birdEl.classList.add('flip');
  place(W - 200, H - 150);
  birdEl.hidden = false;
  flap(true, 80);
  say([`${note.toName === '모두' ? '모두' : note.toName + ' 님'}에게 출발!`, null]);
  await sleep(700);
  say(null);
  await flyTo(-240, H * 0.08, 2600, 35);
  birdEl.hidden = true;
}

// ---------- 대기열 ----------
const queue = [];
let busy = false;
let completed = 0;

window.bird.onFly((flight) => {
  queue.push(flight);
  run();
});

async function run() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const f = queue.shift();
    try {
      if (f.kind === 'in') await deliver(f.note, f.replay);
      else await departure(f.note);
    } catch (e) {
      console.error(e);
    }
    completed += 1;
    clearInterval(frameTimer);
    birdEl.hidden = true;
    letter.hidden = true;
    releaseMouse();
  }
  busy = false;
  window.bird.overlayDone(completed);
}
