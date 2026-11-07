// 교정 시뮬레이션: 치아 절단연 핀(원래 위치) → 이상적 배열(목표 위치)로
// MLS(Moving Least Squares, Schaefer et al. 2006) 아핀 변형을 사용해 입 안쪽 이미지를 워핑한다.
// 입술 윤곽 위에 고정 앵커를 두어 입술·얼굴은 움직이지 않는다. DOM 의존성 없음.

/**
 * 이상적 배열 목표 계산.
 *  - 정중선(midX) 기준 좌우 대칭이 되도록 쌍(가까운 순)의 거리를 평균
 *  - 절단연 높이는 y = c − a·(x−m)² (스마일 아크, a≥0) 최소제곱 적합
 * @param pins [{x,y}] 원래 위치
 * @returns [{x,y}] 같은 순서의 목표 위치
 */
export function computeIdealTargets(pins, midX = null, { arcBoost = 0 } = {}) {
  if (!pins.length) return [];
  const m = midX ?? pins.reduce((s, p) => s + p.x, 0) / pins.length;
  const idx = pins.map((p, i) => i);
  const left = idx.filter((i) => pins[i].x < m).sort((i, j) => pins[j].x - pins[i].x);
  const right = idx.filter((i) => pins[i].x >= m).sort((i, j) => pins[i].x - pins[j].x);
  const tx = pins.map((p) => p.x);
  const pairs = Math.min(left.length, right.length);
  for (let k = 0; k < pairs; k++) {
    const d = (m - pins[left[k]].x + pins[right[k]].x - m) / 2;
    tx[left[k]] = m - d;
    tx[right[k]] = m + d;
  }
  // y = c − a·u, u = (x−m)²  → 선형 최소제곱 (y = c + k·u, a = −k)
  let su = 0, sy = 0, suu = 0, suy = 0;
  const n = pins.length;
  for (const p of pins) {
    const u = (p.x - m) ** 2;
    su += u; sy += p.y; suu += u * u; suy += u * p.y;
  }
  const den = n * suu - su * su;
  let k = den > 1e-9 ? (n * suy - su * sy) / den : 0;
  k = Math.min(0, k); // 중앙이 더 아래(이미지 y 큼)인 스마일 아크만 허용
  if (arcBoost && pins.length > 1) {
    const span = Math.max(...pins.map((p) => Math.abs(p.x - m))) || 1;
    k -= (arcBoost * span * 0.04) / (span * span);
  }
  const c = (sy - k * su) / n;
  return pins.map((p, i) => ({ x: tx[i], y: c + k * (tx[i] - m) ** 2 }));
}

/**
 * MLS 아핀 역매핑: 출력 좌표 v 에 대해 원본 좌표 f(v)를 반환.
 * P: 출력(목표) 제어점, Q: 원본 제어점.
 */
export function mlsAffine(vx, vy, P, Q, out) {
  const n = P.length;
  let sw = 0, px = 0, py = 0, qx = 0, qy = 0;
  const W = mlsAffine._w.length >= n ? mlsAffine._w : (mlsAffine._w = new Float64Array(n * 2));
  for (let i = 0; i < n; i++) {
    const dx = P[i].x - vx;
    const dy = P[i].y - vy;
    const d2 = dx * dx + dy * dy;
    if (d2 < 1e-8) { out[0] = Q[i].x; out[1] = Q[i].y; return out; }
    const wi = 1 / d2;
    W[i] = wi;
    sw += wi; px += wi * P[i].x; py += wi * P[i].y; qx += wi * Q[i].x; qy += wi * Q[i].y;
  }
  px /= sw; py /= sw; qx /= sw; qy /= sw;
  let a11 = 0, a12 = 0, a22 = 0, b11 = 0, b12 = 0, b21 = 0, b22 = 0;
  for (let i = 0; i < n; i++) {
    const wi = W[i];
    const phx = P[i].x - px, phy = P[i].y - py;
    const qhx = Q[i].x - qx, qhy = Q[i].y - qy;
    a11 += wi * phx * phx; a12 += wi * phx * phy; a22 += wi * phy * phy;
    b11 += wi * phx * qhx; b12 += wi * phx * qhy; b21 += wi * phy * qhx; b22 += wi * phy * qhy;
  }
  const det = a11 * a22 - a12 * a12;
  const dvx = vx - px, dvy = vy - py;
  if (Math.abs(det) < 1e-9) { out[0] = dvx + qx; out[1] = dvy + qy; return out; }
  const i11 = a22 / det, i12 = -a12 / det, i22 = a11 / det;
  // M = A^-1 B ;  f = (v − p*) M + q*
  const m11 = i11 * b11 + i12 * b21, m12 = i11 * b12 + i12 * b22;
  const m21 = i12 * b11 + i22 * b21, m22 = i12 * b12 + i22 * b22;
  out[0] = dvx * m11 + dvy * m21 + qx;
  out[1] = dvx * m12 + dvy * m22 + qy;
  return out;
}
mlsAffine._w = new Float64Array(64);

function sample(data, w, h, x, y, ch) {
  x = Math.max(0, Math.min(w - 1.001, x));
  y = Math.max(0, Math.min(h - 1.001, y));
  const x0 = x | 0, y0 = y | 0;
  const fx = x - x0, fy = y - y0;
  const i00 = (y0 * w + x0) * 4 + ch;
  const i10 = i00 + 4;
  const i01 = i00 + w * 4;
  const i11 = i01 + 4;
  return (data[i00] * (1 - fx) + data[i10] * fx) * (1 - fy) + (data[i01] * (1 - fx) + data[i11] * fx) * fy;
}

function sampleF(arr, w, h, x, y) {
  x = Math.max(0, Math.min(w - 1.001, x));
  y = Math.max(0, Math.min(h - 1.001, y));
  const x0 = x | 0, y0 = y | 0;
  const fx = x - x0, fy = y - y0;
  const i = y0 * w + x0;
  return (arr[i] * (1 - fx) + arr[i + 1] * fx) * (1 - fy) + (arr[i + w] * (1 - fx) + arr[i + w + 1] * fx) * fy;
}

/**
 * 입 안쪽 워핑.
 * @param src 원본 이미지, @param out 결과(제자리 수정, 보통 src 복제본)
 * @param seg 분할 결과 (insideSoft, curve, bbox, mask)
 * @param pins [{sx,sy,tx,ty}], @param strength 0..1
 * @returns 워핑된 치아 마스크 Float32Array
 */
export function warpMouth(src, out, seg, pins, strength = 1) {
  const { width: w, height: h } = src;
  const { bbox, insideSoft, curve } = seg;
  const mask = Float32Array.from(seg.mask);
  if (!pins.length || strength <= 0) return mask;
  const P = [];
  const Q = [];
  // 핀 1개당 치관 전체가 함께 움직이도록 절단연 좌우·치관 중앙에도 같은 변위의 제어점을 둔다
  const toothH = (bbox.y1 - bbox.y0) * 0.32;
  const sorted = pins.map((p) => p.sx).sort((a, b) => a - b);
  for (const p of pins) {
    let gap = Infinity;
    for (const x of sorted) if (x !== p.sx) gap = Math.min(gap, Math.abs(x - p.sx));
    if (!isFinite(gap)) gap = (bbox.x1 - bbox.x0) / 8;
    const hw = gap * 0.3;
    const dx = (p.tx - p.sx) * strength;
    const dy = (p.ty - p.sy) * strength;
    for (const [ox, oy] of [[0, 0], [-hw, -toothH * 0.08], [hw, -toothH * 0.08], [0, -toothH * 0.5]]) {
      P.push({ x: p.sx + ox + dx, y: p.sy + oy + dy });
      Q.push({ x: p.sx + ox, y: p.sy + oy });
    }
  }
  // 입술 고정 앵커 (곡선에서 균등 추출)
  const step = Math.max(1, Math.floor(curve.length / 28));
  for (let i = 0; i < curve.length; i += step) { P.push(curve[i]); Q.push(curve[i]); }

  // 격자에서 매핑 계산 후 쌍선형 보간 (속도)
  const G = 4;
  const gw = Math.ceil((bbox.x1 - bbox.x0) / G) + 2;
  const gh = Math.ceil((bbox.y1 - bbox.y0) / G) + 2;
  const mx = new Float32Array(gw * gh);
  const my = new Float32Array(gw * gh);
  const tmp = [0, 0];
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      mlsAffine(bbox.x0 + gx * G, bbox.y0 + gy * G, P, Q, tmp);
      mx[gy * gw + gx] = tmp[0];
      my[gy * gw + gx] = tmp[1];
    }
  }
  const sd = src.data;
  const od = out.data;
  for (let y = bbox.y0; y < bbox.y1; y++) {
    for (let x = bbox.x0; x < bbox.x1; x++) {
      const i = y * w + x;
      const a = insideSoft[i];
      if (a <= 0.01) continue;
      const fx = (x - bbox.x0) / G;
      const fy = (y - bbox.y0) / G;
      const sx = sampleF(mx, gw, gh, fx, fy);
      const sy = sampleF(my, gw, gh, fx, fy);
      const j = i * 4;
      for (let c = 0; c < 3; c++) od[j + c] = od[j + c] + (sample(sd, w, h, sx, sy, c) - od[j + c]) * a;
      mask[i] = sampleF(seg.mask, w, h, sx, sy) * a + seg.mask[i] * (1 - a);
    }
  }
  return mask;
}
