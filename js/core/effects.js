// 치료 효과 시뮬레이션 (규칙 기반 영상처리). DOM 의존성 없음.
// 모든 함수는 out(ImageData 유사)을 제자리 수정하며 bbox 내부만 처리한다.

import { rgbToLab, labToRgb, imageToLab } from './color.js';
import { normalizedBlur, boxBlur } from './imageops.js';

export function cloneImage(img) {
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
}

/**
 * 미백: 치아 마스크 영역의 Lab 을 (목표 쉐이드 − 현재 쉐이드)만큼 이동.
 * 질감(명암 변화)은 유지되고 평균 색만 이동한다.
 */
export function applyWhitening(out, mask, bbox, { from, to, strength = 1 }) {
  const dL = (to.L - from.L) * strength;
  const da = (to.a - from.a) * strength * 0.5; // a*(적록) 이동은 절반만: 녹색 끼 방지
  const db = (to.b - from.b) * strength;
  const { width: w, data } = out;
  const lab = [0, 0, 0];
  const rgb = [0, 0, 0];
  for (let y = bbox.y0; y < bbox.y1; y++) {
    for (let x = bbox.x0; x < bbox.x1; x++) {
      const i = y * w + x;
      const m = mask[i];
      if (m <= 0.01) continue;
      const j = i * 4;
      rgbToLab(data[j], data[j + 1], data[j + 2], lab);
      // 그림자 영역(입 안쪽 어두운 치아)은 덜 밝혀 자연스럽게
      const shade = Math.min(1, Math.max(0.35, (lab[0] - 25) / 45));
      labToRgb(lab[0] + dL * shade, lab[1] + da, lab[2] + db * shade, rgb);
      data[j] = data[j] + (rgb[0] - data[j]) * m;
      data[j + 1] = data[j + 1] + (rgb[1] - data[j + 1]) * m;
      data[j + 2] = data[j + 2] + (rgb[2] - data[j + 2]) * m;
    }
  }
}

/**
 * 레진(부분 수복):
 *  1) 착색/어두운 점(충치·변색 의심 부위)을 주변 건전 치질 색으로 메움
 *  2) 치아 사이 작은 틈(정중이개·블랙트라이앵글)을 가로 방향으로 메움
 * 반환: 갱신된 치아 마스크(틈을 메운 부분 포함)
 */
export function applyResin(out, seg, { stain = 0.7, gap = 0.5 }) {
  const { width: w, height: h, data } = out;
  const { bbox, inside } = seg;
  const mask = Float32Array.from(seg.mask);
  const bw = bbox.x1 - bbox.x0;
  const lab = imageToLab(out, bbox);
  const n = w * h;

  // --- 1) 틈 메우기: 각 행에서 치아 런 사이의 짧은 비치아 구간 ---
  const fill = new Float32Array(n);
  if (gap > 0) {
    const maxGap = Math.round(bw * 0.06 * gap) + 1;
    for (let y = bbox.y0; y < bbox.y1; y++) {
      let lastTooth = -1;
      for (let x = bbox.x0; x < bbox.x1; x++) {
        const i = y * w + x;
        if (mask[i] >= 0.5) {
          if (lastTooth >= 0 && x - lastTooth - 1 > 0 && x - lastTooth - 1 <= maxGap) {
            for (let k = lastTooth + 1; k < x; k++) if (inside[y * w + k]) fill[y * w + k] = 1;
          }
          lastTooth = x;
        }
      }
    }
  }

  // --- 2) 착색 검출: 국소 평균보다 어둡거나 누런 치아 픽셀 ---
  const stainW = new Float32Array(n);
  const r = Math.max(2, Math.round(bw / 30));
  const toothW = new Float32Array(n);
  for (let i = 0; i < n; i++) toothW[i] = mask[i] >= 0.5 ? 1 : 0;
  if (stain > 0) {
    const localL = normalizedBlur(lab.L, toothW, w, h, r, bbox).value;
    const localB = normalizedBlur(lab.B, toothW, w, h, r, bbox).value;
    for (let y = bbox.y0; y < bbox.y1; y++) {
      for (let x = bbox.x0; x < bbox.x1; x++) {
        const i = y * w + x;
        if (!toothW[i]) continue;
        const dark = (localL[i] - lab.L[i] - 5) / 10;
        const yellow = (lab.B[i] - localB[i] - 6) / 10;
        const s = Math.max(0, Math.min(1, Math.max(dark, yellow)));
        stainW[i] = s * stain;
      }
    }
  }

  // --- 3) 채울 색 = 건전 치질(착색·틈 제외)의 정규화 블러 ---
  const healthy = new Float32Array(n);
  for (let i = 0; i < n; i++) healthy[i] = toothW[i] * (1 - Math.min(1, stainW[i] * 1.5)) * (fill[i] ? 0 : 1);
  const target = new Float32Array(n);
  for (let i = 0; i < n; i++) target[i] = Math.max(stainW[i], fill[i]);
  const fillSoft = boxBlur(fill, w, h, 1, bbox, 1);
  const rr = Math.max(r, Math.round(bw * 0.05 * gap) + 2);
  const ch = [lab.L, lab.A, lab.B].map((c) => normalizedBlur(c, healthy, w, h, rr, bbox).value);
  const rgb = [0, 0, 0];
  const texture = boxBlur(lab.L, w, h, 1, bbox, 1);
  for (let y = bbox.y0; y < bbox.y1; y++) {
    for (let x = bbox.x0; x < bbox.x1; x++) {
      const i = y * w + x;
      const t = Math.max(target[i], fillSoft[i] * (inside[i] ? 1 : 0));
      if (t <= 0.01) continue;
      // 미세 질감을 약간 남김
      const detail = (lab.L[i] - texture[i]) * 0.3;
      labToRgb(ch[0][i] + detail, ch[1][i], ch[2][i], rgb);
      const j = i * 4;
      data[j] = data[j] + (rgb[0] - data[j]) * t;
      data[j + 1] = data[j + 1] + (rgb[1] - data[j + 1]) * t;
      data[j + 2] = data[j + 2] + (rgb[2] - data[j + 2]) * t;
      if (fill[i] || fillSoft[i] > 0.3) mask[i] = Math.max(mask[i], fillSoft[i] * inside[i]);
    }
  }
  return mask;
}

/**
 * 라미네이트/비니어 표면 정리: 치아 표면 색 얼룩을 줄이고 매끈하게(일부 질감 유지).
 */
export function applySmoothing(out, mask, bbox, { smooth = 0.6 }) {
  const { width: w, height: h, data } = out;
  const n = w * h;
  const bw = bbox.x1 - bbox.x0;
  const lab = imageToLab(out, bbox);
  const wgt = new Float32Array(n);
  for (let i = 0; i < n; i++) wgt[i] = mask[i] >= 0.5 ? 1 : 0;
  const r = Math.max(2, Math.round(bw / 45));
  const L = normalizedBlur(lab.L, wgt, w, h, r, bbox).value;
  const A = normalizedBlur(lab.A, wgt, w, h, r * 2, bbox).value;
  const B = normalizedBlur(lab.B, wgt, w, h, r * 2, bbox).value;
  const rgb = [0, 0, 0];
  for (let y = bbox.y0; y < bbox.y1; y++) {
    for (let x = bbox.x0; x < bbox.x1; x++) {
      const i = y * w + x;
      const m = mask[i] * smooth;
      if (m <= 0.01) continue;
      // 밝기는 70%만 평활(입체감 유지), 색상은 전부 평활
      const nl = lab.L[i] + (L[i] - lab.L[i]) * 0.7;
      labToRgb(nl, A[i], B[i], rgb);
      const j = i * 4;
      data[j] = data[j] + (rgb[0] - data[j]) * m;
      data[j + 1] = data[j + 1] + (rgb[1] - data[j + 1]) * m;
      data[j + 2] = data[j + 2] + (rgb[2] - data[j + 2]) * m;
    }
  }
}

/**
 * 보철(스마일 템플릿) 합성: 캔버스로 그린 템플릿 레이어(RGBA)를 입술 안쪽에만 합성.
 * 원본 사진의 저주파 밝기(조명·입꼬리 그림자)를 템플릿에 곱해 자연스럽게 만든다.
 */
export function compositeTemplate(out, layer, seg, { opacity = 0.9, lighting = 0.6, hideOriginal = 0.85 }) {
  const { width: w, height: h, data } = out;
  const { bbox, insideSoft, inside } = seg;
  const mask = seg.mask;
  const n = w * h;
  const lum = new Float32Array(n);
  const tw = new Float32Array(n);
  let sum = 0, cnt = 0;
  let dr = 0, dg = 0, db = 0, dc = 0;
  for (let y = bbox.y0; y < bbox.y1; y++) {
    for (let x = bbox.x0; x < bbox.x1; x++) {
      const i = y * w + x;
      const j = i * 4;
      lum[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
      if (mask[i] > 0.5) { tw[i] = 1; sum += lum[i]; cnt++; }
      else if (inside[i] && lum[i] < 70) { dr += data[j]; dg += data[j + 1]; db += data[j + 2]; dc++; }
    }
  }
  const bw = bbox.x1 - bbox.x0;
  // 치아 픽셀만으로 저주파 밝기(조명) 추정 → 어두운 입안 때문에 템플릿이 회색이 되는 것 방지
  const low = normalizedBlur(lum, tw, w, h, Math.max(3, Math.round(bw / 10)), bbox).value;
  const ref = cnt ? sum / cnt : 180;
  const dark = dc ? [dr / dc, dg / dc, db / dc] : [40, 15, 20];
  // 가리기는 템플릿 절단연보다 위쪽(상악)만: 하악 치아는 유지
  let tplBottom = -1;
  for (let y = bbox.y0; y < bbox.y1; y++) for (let x = bbox.x0; x < bbox.x1; x++) if (layer[(y * w + x) * 4 + 3] > 128) tplBottom = y;
  const hideLimit = tplBottom + (bbox.y1 - bbox.y0) * 0.04;
  for (let y = bbox.y0; y < bbox.y1; y++) {
    for (let x = bbox.x0; x < bbox.x1; x++) {
      const i = y * w + x;
      const j = i * 4;
      const ins = insideSoft[i];
      if (ins <= 0.01) continue;
      const la = layer[j + 3] / 255;
      // 템플릿 밖으로 남는 기존 치아는 입안 어두운 색으로 가림(치아 길이·폭 축소 표현)
      const hide = y <= hideLimit ? mask[i] * (1 - la) * hideOriginal * ins : 0;
      if (hide > 0.01) {
        data[j] += (dark[0] - data[j]) * hide;
        data[j + 1] += (dark[1] - data[j + 1]) * hide;
        data[j + 2] += (dark[2] - data[j + 2]) * hide;
      }
      const a = la * opacity * ins;
      if (a <= 0.01) continue;
      const lv = mask[i] > 0.3 ? low[i] : ref;
      const light = 1 + (Math.min(1.12, Math.max(0.7, lv / ref)) - 1) * lighting;
      data[j] += (Math.min(255, layer[j] * light) - data[j]) * a;
      data[j + 1] += (Math.min(255, layer[j + 1] * light) - data[j + 1]) * a;
      data[j + 2] += (Math.min(255, layer[j + 2] * light) - data[j + 2]) * a;
    }
  }
}
