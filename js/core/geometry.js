// 폴리곤/곡선 기하 유틸. DOM 의존성 없음.

export function ellipsePolygon(cx, cy, rx, ry, n = 12) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    pts.push({ x: cx + Math.cos(t) * rx, y: cy + Math.sin(t) * ry });
  }
  return pts;
}

/** 닫힌 Catmull-Rom 스플라인으로 제어점을 부드러운 곡선 점열로 변환 */
export function smoothClosed(points, segments = 8) {
  const n = points.length;
  if (n < 3) return points.slice();
  const out = [];
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];
    for (let s = 0; s < segments; s++) {
      const t = s / segments;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  return out;
}

export function polygonBBox(poly, w, h, pad = 0) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of poly) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return {
    x0: Math.max(0, Math.floor(x0 - pad)),
    y0: Math.max(0, Math.floor(y0 - pad)),
    x1: Math.min(w, Math.ceil(x1 + pad) + 1),
    y1: Math.min(h, Math.ceil(y1 + pad) + 1),
  };
}

export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** 스캔라인 방식 폴리곤 래스터화 (픽셀 중심 기준). 전체 크기 Uint8Array(0/1) 반환 */
export function rasterizePolygon(poly, w, h) {
  const mask = new Uint8Array(w * h);
  const n = poly.length;
  if (n < 3) return mask;
  const bb = polygonBBox(poly, w, h);
  const xs = [];
  for (let y = bb.y0; y < bb.y1; y++) {
    const cy = y + 0.5;
    xs.length = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const a = poly[i];
      const b = poly[j];
      if ((a.y > cy) !== (b.y > cy)) xs.push(a.x + ((cy - a.y) * (b.x - a.x)) / (b.y - a.y));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k] - 0.5));
      const xb = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = xa; x <= xb; x++) mask[y * w + x] = 1;
    }
  }
  return mask;
}

export function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}
