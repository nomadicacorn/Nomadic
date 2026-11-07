// 저수준 이미지 연산 (블러, 모폴로지, Otsu, 연결요소). DOM 의존성 없음.

/**
 * 분리형 박스 블러 (경계는 창 내부 유효 픽셀 수로 정규화).
 * bbox 영역만 처리. passes=2~3 이면 가우시안 근사.
 */
export function boxBlur(src, w, h, r, bbox = { x0: 0, y0: 0, x1: w, y1: h }, passes = 2) {
  r = Math.max(0, Math.round(r));
  let a = Float32Array.from(src);
  if (r === 0) return a;
  let b = new Float32Array(src.length);
  const { x0, y0, x1, y1 } = bbox;
  for (let p = 0; p < passes; p++) {
    // 가로
    for (let y = y0; y < y1; y++) {
      const row = y * w;
      let sum = 0;
      let cnt = 0;
      for (let x = x0; x < Math.min(x1, x0 + r + 1); x++) { sum += a[row + x]; cnt++; }
      for (let x = x0; x < x1; x++) {
        b[row + x] = sum / cnt;
        const add = x + r + 1;
        const rem = x - r;
        if (add < x1) { sum += a[row + add]; cnt++; }
        if (rem >= x0) { sum -= a[row + rem]; cnt--; }
      }
    }
    // 세로
    for (let x = x0; x < x1; x++) {
      let sum = 0;
      let cnt = 0;
      for (let y = y0; y < Math.min(y1, y0 + r + 1); y++) { sum += b[y * w + x]; cnt++; }
      for (let y = y0; y < y1; y++) {
        a[y * w + x] = sum / cnt;
        const add = y + r + 1;
        const rem = y - r;
        if (add < y1) { sum += b[add * w + x]; cnt++; }
        if (rem >= y0) { sum -= b[rem * w + x]; cnt--; }
      }
    }
  }
  return a;
}

/** 정규화 컨볼루션: weight 가 있는 픽셀 값만으로 주변을 채움 (inpainting 근사) */
export function normalizedBlur(values, weight, w, h, r, bbox, passes = 2) {
  const n = values.length;
  const vw = new Float32Array(n);
  for (let i = 0; i < n; i++) vw[i] = values[i] * weight[i];
  const bv = boxBlur(vw, w, h, r, bbox, passes);
  const bw = boxBlur(weight, w, h, r, bbox, passes);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = bw[i] > 1e-4 ? bv[i] / bw[i] : values[i];
  return { value: out, weight: bw };
}

function morph(mask, w, h, r, bbox, isDilate) {
  const tmp = new Uint8Array(mask.length);
  const out = new Uint8Array(mask.length);
  const { x0, y0, x1, y1 } = bbox;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      let v = isDilate ? 0 : 1;
      for (let k = Math.max(x0, x - r); k <= Math.min(x1 - 1, x + r); k++) {
        const m = mask[y * w + k];
        if (isDilate ? m : !m) { v = isDilate ? 1 : 0; break; }
      }
      tmp[y * w + x] = v;
    }
  }
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      let v = isDilate ? 0 : 1;
      for (let k = Math.max(y0, y - r); k <= Math.min(y1 - 1, y + r); k++) {
        const m = tmp[k * w + x];
        if (isDilate ? m : !m) { v = isDilate ? 1 : 0; break; }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

export const dilate = (m, w, h, r, bb) => morph(m, w, h, r, bb, true);
export const erode = (m, w, h, r, bb) => morph(m, w, h, r, bb, false);
export const open = (m, w, h, r, bb) => dilate(erode(m, w, h, r, bb), w, h, r, bb);
export const close = (m, w, h, r, bb) => erode(dilate(m, w, h, r, bb), w, h, r, bb);

/** 히스토그램 기반 Otsu 임계값 */
export function otsu(hist) {
  let total = 0;
  let sumAll = 0;
  for (let i = 0; i < hist.length; i++) { total += hist[i]; sumAll += i * hist[i]; }
  if (total === 0) return hist.length / 2;
  let wB = 0;
  let sumB = 0;
  let best = 0;
  let bestT = 0;
  for (let t = 0; t < hist.length; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; bestT = t; }
  }
  return bestT + 0.5;
}

/**
 * 값이 `target`(0/1)인 연결요소 중 크기가 minSize 미만인 것을 반전.
 * (target=1: 작은 노이즈 제거, target=0: 작은 구멍 메움). 4-연결.
 * limit 마스크가 주어지면 그 안에서만 판단.
 */
export function removeSmall(mask, w, h, minSize, bbox, target = 1, limit = null) {
  const out = Uint8Array.from(mask);
  const seen = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  const comp = [];
  const { x0, y0, x1, y1 } = bbox;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const s = y * w + x;
      if (seen[s] || out[s] !== target || (limit && !limit[s])) continue;
      let sp = 0;
      stack[sp++] = s;
      seen[s] = 1;
      comp.length = 0;
      let touchesEdge = false;
      while (sp) {
        const i = stack[--sp];
        comp.push(i);
        const cx = i % w;
        const cy = (i / w) | 0;
        const nb = [cx > x0 ? i - 1 : -1, cx < x1 - 1 ? i + 1 : -1, cy > y0 ? i - w : -1, cy < y1 - 1 ? i + w : -1];
        if (nb.includes(-1)) touchesEdge = true;
        for (const j of nb) {
          if (j < 0) continue;
          if (limit && !limit[j]) { touchesEdge = true; continue; }
          if (!seen[j] && out[j] === target) { seen[j] = 1; stack[sp++] = j; }
        }
      }
      // 구멍 메우기 시에는 경계에 닿은 배경은 구멍이 아님
      if (comp.length < minSize && !(target === 0 && touchesEdge)) {
        for (const i of comp) out[i] = 1 - target;
      }
    }
  }
  return out;
}
