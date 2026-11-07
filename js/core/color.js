// sRGB <-> CIELAB (D65) 변환. DOM 의존성 없음.

const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

const XN = 0.95047;
const YN = 1.0;
const ZN = 1.08883;
const EPS = 0.008856;
const KAPPA = 7.787;

function f(t) {
  return t > EPS ? Math.cbrt(t) : KAPPA * t + 16 / 116;
}

function finv(t) {
  const t3 = t * t * t;
  return t3 > EPS ? t3 : (t - 16 / 116) / KAPPA;
}

function gamma(c) {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return v <= 0 ? 0 : v >= 1 ? 255 : v * 255;
}

/** r,g,b: 0..255 정수. out: [L,a,b] */
export function rgbToLab(r, g, b, out = [0, 0, 0]) {
  const R = LIN[r | 0];
  const G = LIN[g | 0];
  const B = LIN[b | 0];
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / XN;
  const y = (R * 0.2126 + G * 0.7152 + B * 0.0722) / YN;
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / ZN;
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  out[0] = 116 * fy - 16;
  out[1] = 500 * (fx - fy);
  out[2] = 200 * (fy - fz);
  return out;
}

/** out: [r,g,b] 0..255 실수 (클램프됨) */
export function labToRgb(L, a, b, out = [0, 0, 0]) {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const X = XN * finv(fx);
  const Y = YN * finv(fy);
  const Z = ZN * finv(fz);
  out[0] = gamma(3.2406 * X - 1.5372 * Y - 0.4986 * Z);
  out[1] = gamma(-0.9689 * X + 1.8758 * Y + 0.0415 * Z);
  out[2] = gamma(0.0557 * X - 0.204 * Y + 1.057 * Z);
  return out;
}

/** 이미지의 bbox 영역을 Lab 평면 3개(Float32Array, 전체 크기)로 변환 */
export function imageToLab(img, bbox) {
  const { width: w, data } = img;
  const n = w * img.height;
  const L = new Float32Array(n);
  const A = new Float32Array(n);
  const B = new Float32Array(n);
  const lab = [0, 0, 0];
  for (let y = bbox.y0; y < bbox.y1; y++) {
    for (let x = bbox.x0; x < bbox.x1; x++) {
      const i = y * w + x;
      const j = i * 4;
      rgbToLab(data[j], data[j + 1], data[j + 2], lab);
      L[i] = lab[0];
      A[i] = lab[1];
      B[i] = lab[2];
    }
  }
  return { L, A, B };
}
