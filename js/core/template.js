// 보철(라미네이트·크라운) 스마일 템플릿: 치아 형태 라이브러리를 스마일 아크를 따라 배치.
// 레이아웃 계산은 순수 함수, 그리기는 CanvasRenderingContext2D 호환 ctx 를 받는다.

import { labToRgb } from './color.js';

// 정면에서 보이는 겉보기 폭 비율 (중절치=1)
const NATURAL_W = [1, 0.7, 0.55, 0.42, 0.36];
const GOLDEN_W = [1, 0.618, 0.382, 0.3, 0.25];
const HEIGHT = [1, 0.84, 0.96, 0.8, 0.74];

/** 한쪽 치아 겉보기 폭 합 (중절치 폭 배수) */
export function halfSpanFactor(count, golden) {
  const widths = golden ? GOLDEN_W : NATURAL_W;
  const perSide = Math.max(1, Math.min(5, Math.round(count / 2)));
  return widths.slice(0, perSide).reduce((a, b) => a + b, 0);
}

export const STYLES = {
  oval: { label: '오벌(부드러운)', taper: 0.78, incisal: 0.38, cervical: 0.45 },
  square: { label: '스퀘어(남성적)', taper: 0.92, incisal: 0.14, cervical: 0.35 },
  triangle: { label: '트라이앵글(갸름한)', taper: 0.62, incisal: 0.24, cervical: 0.5 },
};

/**
 * @param p {cx, cy(중절치 절단연 높이), w(중절치 폭), hRatio, curve(0..1), count(6/8/10), golden}
 * @returns [{x(좌측), top, w, h, rank, side}] 그리기 순서(바깥→안쪽)
 */
export function layoutTeeth(p) {
  const widths = p.golden ? GOLDEN_W : NATURAL_W;
  const perSide = Math.max(1, Math.min(5, Math.round(p.count / 2)));
  const H = p.w * p.hRatio;
  const teeth = [];
  let span = 0;
  for (let r = 0; r < perSide; r++) span += widths[r] * p.w;
  for (const side of [-1, 1]) {
    let offset = 0;
    for (let r = 0; r < perSide; r++) {
      const tw = widths[r] * p.w;
      const center = p.cx + side * (offset + tw / 2);
      const u = (offset + tw / 2) / span;
      const edge = p.cy - p.curve * u * u * H * 0.55 - (r === 2 ? -H * 0.03 : 0);
      const th = H * HEIGHT[r];
      teeth.push({ x: center - tw / 2, top: edge - th, w: tw, h: th, rank: r, side });
      offset += tw;
    }
  }
  return teeth.sort((a, b) => b.rank - a.rank);
}

function toothPath(ctx, t, style) {
  const s = STYLES[style] || STYLES.oval;
  const { x, top, w, h } = t;
  const inset = (w * (1 - s.taper)) / 2;
  const ri = w * s.incisal;
  const bottom = top + h;
  const ext = h * 0.6; // 치경부를 위로 연장 → 입술 뒤로 숨겨져 잇몸선 아래 빈틈이 생기지 않음
  ctx.beginPath();
  ctx.moveTo(x + inset, top - ext);
  ctx.lineTo(x + w - inset, top - ext);
  ctx.lineTo(x + w - inset, top);
  // 원심/근심면: 경부에서 최대풍융부로 볼록하게
  ctx.bezierCurveTo(x + w + w * 0.02, top + h * s.cervical, x + w, bottom - ri, x + w - ri * 0.2, bottom - ri * 0.4);
  ctx.quadraticCurveTo(x + w - ri * 0.5, bottom, x + w - ri, bottom);
  ctx.lineTo(x + ri, bottom);
  ctx.quadraticCurveTo(x + ri * 0.5, bottom, x + ri * 0.2, bottom - ri * 0.4);
  ctx.bezierCurveTo(x, bottom - ri, x - w * 0.02, top + h * s.cervical, x + inset, top);
  ctx.lineTo(x + inset, top - ext);
  ctx.closePath();
}

function css(L, a, b, alpha = 1) {
  const c = labToRgb(L, a, b);
  return `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${alpha})`;
}

/** ctx 에 템플릿 치아를 그림 (투명 배경 위). shade: {L,a,b} */
export function drawTemplate(ctx, params, shade) {
  const teeth = layoutTeeth(params);
  for (const t of teeth) {
    const depth = t.rank * 3.2; // 뒤쪽 치아일수록 어둡게
    const L = shade.L - depth;
    toothPath(ctx, t, params.style);
    const g = ctx.createLinearGradient(0, t.top, 0, t.top + t.h);
    g.addColorStop(0, css(L - 7, shade.a + 1.5, shade.b + 6));
    g.addColorStop(0.35, css(L - 1, shade.a + 0.5, shade.b + 2));
    g.addColorStop(0.75, css(L + 1, shade.a, shade.b));
    g.addColorStop(0.93, css(L - 6, shade.a - 1, shade.b - 6, 0.95));
    g.addColorStop(1, css(L - 14, shade.a - 1, shade.b - 8, 0.85));
    ctx.fillStyle = g;
    ctx.fill();
    // 좌우 입체감 (근원심 쪽 음영)
    const hg = ctx.createLinearGradient(t.x, 0, t.x + t.w, 0);
    hg.addColorStop(0, 'rgba(60,45,35,0.32)');
    hg.addColorStop(0.18, 'rgba(60,45,35,0)');
    hg.addColorStop(0.82, 'rgba(60,45,35,0)');
    hg.addColorStop(1, 'rgba(60,45,35,0.32)');
    ctx.fillStyle = hg;
    ctx.fill();
    // 하이라이트
    const hl = ctx.createRadialGradient(t.x + t.w * 0.45, t.top + t.h * 0.55, 1, t.x + t.w * 0.45, t.top + t.h * 0.55, t.w * 0.45);
    hl.addColorStop(0, 'rgba(255,255,255,0.22)');
    hl.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hl;
    ctx.fill();
    ctx.lineWidth = Math.max(1, t.w * 0.02);
    ctx.strokeStyle = 'rgba(90,70,55,0.35)';
    ctx.stroke();
  }
  return teeth;
}
