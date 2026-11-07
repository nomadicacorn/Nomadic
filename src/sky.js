// 서울 하늘 — 실제 태양 고도(한국 시간)에 따라 배경이 밤 → 여명 → 일출 → 낮 → 노을 → 황혼으로 바뀐다
const RAD = Math.PI / 180;
const LAT = 37.5665 * RAD, LON = 126.978;

export function sunPosition(date) {
  const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * RAD;
  const lam = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const eps = (23.439 - 0.0000004 * n) * RAD;
  const dec = Math.asin(Math.sin(eps) * Math.sin(lam));
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
  const gmst = ((18.697374558 + 24.06570982441908 * n) % 24 + 24) % 24;
  let H = (gmst * 15 + LON) * RAD - ra;
  H = Math.atan2(Math.sin(H), Math.cos(H));
  const el = Math.asin(Math.sin(LAT) * Math.sin(dec) + Math.cos(LAT) * Math.cos(dec) * Math.cos(H)) / RAD;
  return { el, morning: H < 0 };
}

/** ?time=18:20 으로 시간을 바꿔 미리 볼 수 있다 */
export function skyDate() {
  const q = new URLSearchParams(location.search).get('time');
  const now = new Date();
  if (!q || !/^\d{1,2}(:\d{2})?$/.test(q)) return now;
  const [h, m = '0'] = q.split(':');
  const kst = new Date(now.getTime() + 9 * 3600e3);
  return new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate(), +h - 9, +m));
}

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const ss = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

// 키프레임: [태양고도, 하늘 위, 지평선, 태양빛]
const KEYS = [
  [-18, [0.010, 0.006, 0.030], [0.025, 0.012, 0.060], [0.00, 0.00, 0.00]],  // 밤
  [-10, [0.018, 0.016, 0.075], [0.110, 0.040, 0.170], [0.25, 0.06, 0.28]],  // 푸른 시간 / 여명
  [-3,  [0.040, 0.035, 0.140], [0.380, 0.120, 0.200], [0.70, 0.22, 0.30]],  // 해 뜨기 직전 분홍
  [3,   [0.060, 0.060, 0.170], [0.520, 0.200, 0.090], [1.00, 0.50, 0.18]],  // 일출·일몰 금빛
  [12,  [0.040, 0.090, 0.210], [0.200, 0.200, 0.250], [0.55, 0.45, 0.30]],  // 오전·오후
  [35,  [0.025, 0.090, 0.230], [0.100, 0.200, 0.320], [0.25, 0.28, 0.30]],  // 한낮
];

export function skyState(date = skyDate()) {
  const { el, morning } = sunPosition(date);
  let i = 0;
  while (i < KEYS.length - 2 && el > KEYS[i + 1][0]) i++;
  const a = KEYS[i], b = KEYS[i + 1];
  const t = ss(a[0], b[0], el);
  const top = mix(a[1], b[1], t), hor = mix(a[2], b[2], t), glow = mix(a[3], b[3], t);
  const warm = ss(-12, -3, el) * (1 - ss(6, 16, el));       // 노을빛 정도
  const stars = 1 - ss(-10, 4, el) * 0.75;                   // 낮에도 우주는 조금 보인다
  let phase;
  if (el < -12) phase = '밤';
  else if (el < -2) phase = morning ? '새벽 여명' : '황혼';
  else if (el < 8) phase = morning ? '일출' : '일몰';
  else phase = morning ? '오전' : '오후';
  const kst = new Date(date.getTime() + 9 * 3600e3);
  const hhmm = `${String(kst.getUTCHours()).padStart(2, '0')}:${String(kst.getUTCMinutes()).padStart(2, '0')}`;
  return {
    el, morning, phase, hhmm, top, hor, glow, warm, stars,
    sunX: morning ? 0.2 : 0.8,
    sunY: -0.15 + Math.max(-0.2, Math.min(0.6, el / 40)),
  };
}
