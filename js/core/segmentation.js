// 규칙 기반(색상 통계) 치아 영역 분할.
// ⚠️ AI 모델이 아님: 입술 내측 윤곽 안에서 "밝고 붉지 않은" 픽셀을 Otsu 임계값으로 분리한다.
// 향후 AI 분할 모델(js/ai/provider.js)로 교체 가능하도록 동일한 결과 형식을 반환한다.

import { imageToLab } from './color.js';
import { smoothClosed, rasterizePolygon, polygonBBox } from './geometry.js';
import { boxBlur, otsu, open, close, removeSmall } from './imageops.js';

const BINS = 160;
const SMIN = -60;
const SMAX = 100;

/** 치아다움 점수: 밝기는 높이고, 붉은 기(잇몸·입술·혀)와 과도한 황색은 깎는다 */
export function toothScore(L, a, b) {
  return L - 1.6 * Math.max(a - 4, 0) - 0.4 * Math.max(b - 28, 0);
}

/**
 * @param img ImageData 유사 객체 {width,height,data}
 * @param lipPoly 입술 내측 윤곽 제어점 [{x,y}]
 * @param opts.sensitivity -20..20 (양수일수록 더 넓게 치아로 판정)
 * @param opts.edits Int8Array(전체 크기) +1 강제 포함, -1 강제 제외 (수동 브러시)
 */
export function segmentTeeth(img, lipPoly, opts = {}) {
  const { sensitivity = 0, edits = null } = opts;
  const { width: w, height: h } = img;
  const curve = smoothClosed(lipPoly, 8);
  const inside = rasterizePolygon(curve, w, h);
  const bbox = polygonBBox(curve, w, h, 2);
  const lab = imageToLab(img, bbox);
  const score = new Float32Array(w * h);
  const hist = new Float64Array(BINS);
  let insideCount = 0;
  for (let y = bbox.y0; y < bbox.y1; y++) {
    for (let x = bbox.x0; x < bbox.x1; x++) {
      const i = y * w + x;
      if (!inside[i]) continue;
      const s = toothScore(lab.L[i], lab.A[i], lab.B[i]);
      score[i] = s;
      const bin = Math.max(0, Math.min(BINS - 1, Math.floor(((s - SMIN) / (SMAX - SMIN)) * BINS)));
      hist[bin]++;
      insideCount++;
    }
  }
  const tBin = otsu(hist);
  const threshold = SMIN + (tBin / BINS) * (SMAX - SMIN) - sensitivity;

  let bin = new Uint8Array(w * h);
  for (let y = bbox.y0; y < bbox.y1; y++) {
    for (let x = bbox.x0; x < bbox.x1; x++) {
      const i = y * w + x;
      bin[i] = inside[i] && score[i] > threshold ? 1 : 0;
    }
  }

  const bw = bbox.x1 - bbox.x0;
  const r = Math.max(1, Math.round(bw / 400));
  bin = open(bin, w, h, r, bbox);
  bin = close(bin, w, h, r + 1, bbox);
  bin = removeSmall(bin, w, h, Math.max(20, insideCount * 0.004), bbox, 1);
  bin = removeSmall(bin, w, h, Math.max(10, insideCount * 0.002), bbox, 0, inside);

  if (edits) {
    for (let y = bbox.y0; y < bbox.y1; y++) {
      for (let x = bbox.x0; x < bbox.x1; x++) {
        const i = y * w + x;
        if (edits[i] > 0 && inside[i]) bin[i] = 1;
        else if (edits[i] < 0) bin[i] = 0;
      }
    }
  }
  for (let i = 0; i < bin.length; i++) if (!inside[i]) bin[i] = 0;

  const f = new Float32Array(w * h);
  for (let i = 0; i < f.length; i++) f[i] = bin[i];
  const feather = Math.max(1, Math.round(bw / 500));
  const mask = boxBlur(f, w, h, feather, bbox, 2);
  for (let i = 0; i < mask.length; i++) if (!inside[i]) mask[i] *= 0.5; // 입술 경계 밖으로 번지지 않게

  const insideF = new Float32Array(w * h);
  for (let i = 0; i < insideF.length; i++) insideF[i] = inside[i];
  const insideSoft = boxBlur(insideF, w, h, feather + 1, bbox, 2);

  return {
    mask, // Float32 0..1 (부드러운 치아 마스크)
    binary: bin, // Uint8 0/1
    inside, // Uint8 입술 내측
    insideSoft, // Float32 입술 경계 페더
    curve, // 부드러운 입술 곡선 점열
    bbox,
    stats: toothStats(img, mask, bbox),
    threshold,
  };
}

/** 마스크 가중 평균 Lab */
export function toothStats(img, mask, bbox) {
  const { width: w } = img;
  const lab = imageToLab(img, bbox);
  let sw = 0, sL = 0, sA = 0, sB = 0;
  for (let y = bbox.y0; y < bbox.y1; y++) {
    for (let x = bbox.x0; x < bbox.x1; x++) {
      const i = y * w + x;
      const m = mask[i];
      if (m < 0.5) continue;
      sw += m; sL += lab.L[i] * m; sA += lab.A[i] * m; sB += lab.B[i] * m;
    }
  }
  if (sw === 0) return { L: 0, a: 0, b: 0, area: 0 };
  return { L: sL / sw, a: sA / sw, b: sB / sw, area: sw };
}

/**
 * 치아 마스크의 열(column) 프로파일로 상악 전치 위치를 추정해 교정용 핀을 제안.
 * 반환: [{x,y}] 각 치아 절단연(incisal edge) 중앙 추정점. "자동 제안 — 확인 필요".
 */
export function suggestPins(seg, img, maxTeeth = 8) {
  const { binary, bbox } = seg;
  const { width: w, data } = img;
  const bw = bbox.x1 - bbox.x0;
  const bh = bbox.y1 - bbox.y0;
  // 상악 치아만 보기 위해 위쪽 60%만 사용. 치아 사이(인접면)는 어두우므로 밝기×마스크 합의 골을 찾는다.
  const yLimit = bbox.y0 + Math.round(bh * 0.6);
  const prof = new Float32Array(bw);
  for (let x = 0; x < bw; x++) {
    let s = 0;
    for (let y = bbox.y0; y < yLimit; y++) {
      const i = y * w + bbox.x0 + x;
      if (binary[i]) s += 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    }
    prof[x] = s;
  }
  const sm = boxBlur(prof, bw, 1, Math.max(1, Math.round(bw / 200)), { x0: 0, y0: 0, x1: bw, y1: 1 }, 2);
  let maxV = 0;
  for (const v of sm) if (v > maxV) maxV = v;
  if (maxV <= 0) return [];
  const minGap = Math.max(4, Math.round(bw / 18));
  const hw = Math.max(2, Math.round(minGap / 2));
  // 치아 경계 = 주변 창에서 최소이며 양쪽보다 충분히 낮은 골
  const cuts = [];
  for (let x = 1; x < bw - 1; x++) {
    let isMin = true, lmax = 0, rmax = 0;
    for (let k = Math.max(0, x - hw); k <= Math.min(bw - 1, x + hw); k++) {
      if (sm[k] < sm[x]) { isMin = false; break; }
      if (k < x) lmax = Math.max(lmax, sm[k]); else if (k > x) rmax = Math.max(rmax, sm[k]);
    }
    if (!isMin) continue;
    const prom = Math.min(lmax, rmax) - sm[x];
    if (prom > maxV * 0.03 && (!cuts.length || x - cuts[cuts.length - 1] >= minGap)) cuts.push(x);
  }
  // 치아가 있는 구간 시작/끝
  let first = 0;
  let last = bw - 1;
  while (first < bw && sm[first] < maxV * 0.25) first++;
  while (last > 0 && sm[last] < maxV * 0.25) last--;
  const edges = [first, ...cuts.filter((c) => c > first + minGap / 2 && c < last - minGap / 2), last];
  const pins = [];
  for (let k = 0; k + 1 < edges.length; k++) {
    const a = edges[k];
    const b = edges[k + 1];
    if (b - a < minGap * 0.6) continue;
    const cx = Math.round((a + b) / 2);
    // 해당 열 주변에서 위에서부터 첫 치아 런의 아래 끝(절단연)
    let edgeY = -1;
    let inRun = false;
    for (let y = bbox.y0; y < bbox.y1; y++) {
      let c = 0;
      for (let dx = -2; dx <= 2; dx++) c += binary[y * w + bbox.x0 + Math.min(bw - 1, Math.max(0, cx + dx))];
      if (c >= 3) { inRun = true; edgeY = y; } else if (inRun) break;
    }
    if (edgeY > 0) pins.push({ x: bbox.x0 + cx, y: edgeY });
  }
  // 중앙에 가까운 치아부터 maxTeeth 개
  const mid = bbox.x0 + bw / 2;
  pins.sort((p, q) => Math.abs(p.x - mid) - Math.abs(q.x - mid));
  return pins.slice(0, maxTeeth).sort((p, q) => p.x - q.x);
}
