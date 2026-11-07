// 스마일 시뮬레이터 UI 컨트롤러.
// 모든 처리는 브라우저 메모리 안에서만 이루어지며 네트워크 전송 코드는 없다(CSP connect-src 'none').

import { ellipsePolygon, smoothClosed, polygonBBox, dist, clamp } from '../core/geometry.js';
import { suggestPins, segmentTeeth } from '../core/segmentation.js';
import { computeIdealTargets } from '../core/ortho.js';
import { runPipeline } from '../core/pipeline.js';
import { SHADES, estimateShade } from '../core/shades.js';
import { drawTemplate, layoutTeeth, halfSpanFactor } from '../core/template.js';
import { CAPABILITIES } from '../ai/provider.js';
import { Camera } from './camera.js';
import { makeDemoImage } from './demo.js';
import { IdleGuard, loadSettings, saveSettings, scrub, scrubCanvas } from './privacy.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const MAX_DIM = 1600; // 처리 해상도 상한 (성능)
const settings = loadSettings();
const camera = new Camera($('#camera-canvas'));

const view = $('#view');
const vctx = view.getContext('2d');

let S = freshState();

function freshState() {
  return {
    screen: 'welcome',
    original: null, // ImageData
    originalCanvas: null,
    resultCanvas: null,
    maskCanvas: null,
    poly: [],
    edits: null, // Int8Array (+1 추가, -1 제외)
    seg: null,
    result: null,
    resultMask: null,
    segDirty: false,
    resultDirty: false,
    sensitivity: 0,
    tool: 'view',
    compare: 'result',
    hold: false,
    split: 0.5,
    guides: { midline: false, golden: false, smile: false, mask: false },
    midlineX: null,
    pins: [], // {sx,sy,tx,ty}
    manualTargets: false,
    preset: null,
    shadeEst: null,
    whFromUser: false,
    t: {
      whitening: { on: false, from: 'A3', to: 'BL2', strength: 1 },
      resin: { on: false, stain: 0.8, gap: 0.6 },
      veneer: { on: false, smooth: 0.6 },
      template: { on: false, cx: null, cy: null, wScale: 1, hRatio: 1.22, curve: 0.6, style: 'oval', count: 10, shade: 'BL2', opacity: 1, golden: false, lighting: 0.6, hideOriginal: 1 },
      ortho: { on: false, strength: 1, arc: 0 },
    },
    drag: null,
    pointer: null,
  };
}

// ───────────────────────── 화면 전환 ─────────────────────────
function show(name) {
  S.screen = name;
  for (const el of $$('.screen')) el.classList.toggle('active', el.id === `screen-${name}`);
}

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

// ───────────────────────── 시작 화면 ─────────────────────────
$('#consent').addEventListener('change', (e) => {
  $('#btn-camera').disabled = !e.target.checked;
  $('#btn-upload').disabled = !e.target.checked;
});

// 실시간 카메라를 쓸 수 없는 환경(호스팅 페이지·권한 거부 등)에서는 기기 기본 카메라 앱으로 촬영
const NO_LIVE_CAMERA = !!window.SMILESIM_NO_LIVE_CAMERA;
$('#btn-camera').addEventListener('click', async () => {
  if (NO_LIVE_CAMERA || !navigator.mediaDevices?.getUserMedia) { $('#file-capture').click(); return; }
  show('camera');
  camera.mirror = settings.mirror;
  camera.zoom = Number($('#cam-zoom').value);
  try {
    await camera.start();
  } catch {
    camera.stop();
    show('welcome');
    toast('실시간 카메라를 쓸 수 없어 기기 카메라로 촬영합니다.', 3500);
    $('#file-capture').click();
  }
});

$('#btn-upload').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', onPickFile);
$('#file-capture').addEventListener('change', onPickFile);
async function onPickFile(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    // createImageBitmap 은 EXIF 방향만 반영하고 메타데이터(GPS 등)는 픽셀로 옮기지 않는다
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const img = bitmapToImageData(bmp);
    bmp.close();
    const w = img.width, h = img.height;
    loadImage(img, { cx: w / 2, cy: h * 0.55, rx: w * 0.25, ry: h * 0.14 });
    setTool('contour');
    setTab('area');
    toast('입술 안쪽 윤곽 점을 끌어서 치아가 보이는 영역에 맞춰 주세요.', 5000);
  } catch {
    toast('이미지를 열 수 없습니다.');
  }
}

$('#btn-demo').addEventListener('click', () => {
  const { img, guide } = makeDemoImage();
  loadImage(img, guide);
});

function bitmapToImageData(bmp) {
  const scale = Math.min(1, MAX_DIM / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  scrubCanvas(c);
  return img;
}

// ───────────────────────── 촬영 화면 ─────────────────────────
$('#cam-zoom').addEventListener('input', (e) => { camera.zoom = Number(e.target.value); });
$('#btn-cam-back').addEventListener('click', () => { camera.stop(); show('welcome'); });
$('#btn-shoot').addEventListener('click', () => {
  const cd = $('#countdown');
  const btn = $('#btn-shoot');
  btn.disabled = true;
  let n = 3;
  cd.hidden = false;
  cd.textContent = n;
  const iv = setInterval(() => {
    n--;
    if (n > 0) { cd.textContent = n; return; }
    clearInterval(iv);
    cd.hidden = true;
    btn.disabled = false;
    const { img, guide } = camera.capture();
    camera.stop();
    loadImage(img, guide);
  }, 1000);
});

// ───────────────────────── 이미지 로드 ─────────────────────────
function loadImage(img, guide) {
  wipeImageBuffers();
  S.original = img;
  S.originalCanvas = imageToCanvas(img);
  S.poly = guide.poly ? guide.poly.map((q) => ({ ...q })) : ellipsePolygon(guide.cx, guide.cy, guide.rx, guide.ry, 12);
  S.edits = new Int8Array(img.width * img.height);
  S.pins = [];
  S.midlineX = null;
  S.whFromUser = false;
  S.segDirty = true;
  S.resultDirty = true;
  show('studio');
  setTool('view');
  setTab('treat');
  syncControls();
  schedule();
}

function imageToCanvas(img) {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d').putImageData(img, 0, 0);
  return c;
}

// ───────────────────────── 계산 ─────────────────────────
let tplCanvas = null;
function renderTemplateLayer(params, shade, w, h) {
  if (!tplCanvas) tplCanvas = document.createElement('canvas');
  if (tplCanvas.width !== w || tplCanvas.height !== h) { tplCanvas.width = w; tplCanvas.height = h; }
  const ctx = tplCanvas.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, w, h);
  drawTemplate(ctx, templateGeometry(params), shade);
  return ctx.getImageData(0, 0, w, h).data;
}

/** 템플릿 상대 파라미터 → 절대 좌표. 기본 위치·크기는 인식된 상악 치열에 자동 맞춤 */
function templateGeometry(p = S.t.template) {
  const fit = templateFit();
  const count = Number(p.count);
  const w = (fit.extent / 2 / halfSpanFactor(count, p.golden)) * p.wScale;
  return {
    ...p,
    cx: p.cx ?? S.midlineX ?? fit.cx,
    cy: p.cy ?? fit.edgeY,
    w,
    count,
  };
}

/** 상악 치열의 좌우 범위·절단연 높이 추정 (seg 당 1회 캐시) */
function templateFit() {
  if (S.seg._fit) return S.seg._fit;
  const { bbox, binary } = S.seg;
  const w = S.original.width;
  const bw = bbox.x1 - bbox.x0;
  const bh = bbox.y1 - bbox.y0;
  const yLimit = bbox.y0 + Math.round(bh * 0.6);
  const cols = [];
  for (let x = bbox.x0; x < bbox.x1; x++) {
    let c = 0;
    for (let y = bbox.y0; y < yLimit; y++) c += binary[y * w + x];
    if (c > bh * 0.05) cols.push(x);
  }
  const x0 = cols.length ? cols[Math.floor(cols.length * 0.02)] : bbox.x0 + bw * 0.2;
  const x1 = cols.length ? cols[Math.floor(cols.length * 0.98)] : bbox.x1 - bw * 0.2;
  const pins = suggestPins(S.seg, S.original);
  const mid = (x0 + x1) / 2;
  const central = pins.filter((q) => Math.abs(q.x - mid) < (x1 - x0) * 0.2);
  const ref = central.length ? central : pins;
  const edgeY = ref.length ? Math.max(...ref.map((q) => q.y)) : bbox.y0 + bh * 0.58;
  S.seg._fit = { cx: mid, extent: (x1 - x0) * 1.04, edgeY };
  return S.seg._fit;
}

function currentTargets() {
  return S.pins.map((p) => ({ x: p.tx, y: p.ty }));
}

function recomputeTargets() {
  if (S.manualTargets) return;
  const tg = computeIdealTargets(S.pins.map((p) => ({ x: p.sx, y: p.sy })), S.midlineX, { arcBoost: S.t.ortho.arc });
  S.pins.forEach((p, i) => { p.tx = tg[i].x; p.ty = tg[i].y; });
}

function compute() {
  if (!S.original) return;
  if (S.segDirty) {
    S.seg = segment();
    S.segDirty = false;
    S.resultDirty = true;
    S.maskCanvas = makeMaskCanvas(S.seg);
    const est = estimateShade(S.seg.stats);
    S.shadeEst = est;
    $('#shade-est').textContent = est ? est.id : '-';
    if (!S.whFromUser && est) { S.t.whitening.from = est.id; $('#wh-from').value = est.id; }
  }
  if (S.resultDirty) {
    recomputeTargets();
    const plan = { ...S.t, pins: S.pins };
    const { image, mask } = runPipeline(S.original, S.seg, plan, renderTemplateLayer);
    if (S.result) scrub(S.result);
    S.result = image;
    S.resultMask = mask;
    const rc = S.resultCanvas || document.createElement('canvas');
    rc.width = image.width;
    rc.height = image.height;
    rc.getContext('2d').putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
    S.resultCanvas = rc;
    S.resultDirty = false;
  }
}

// AI 연동 지점: 향후 provider.segmentTeeth()(on-device 모델)로 교체. MVP 는 규칙 기반 동기 함수 사용.
function segment() {
  return segmentTeeth(S.original, S.poly, { sensitivity: S.sensitivity, edits: S.edits });
}

function makeMaskCanvas(seg) {
  const { width: w, height: h } = S.original;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  const id = ctx.createImageData(w, h);
  const { bbox, binary } = seg;
  for (let y = bbox.y0; y < bbox.y1; y++) {
    for (let x = bbox.x0; x < bbox.x1; x++) {
      const i = y * w + x;
      if (binary[i]) { const j = i * 4; id.data[j] = 60; id.data[j + 1] = 230; id.data[j + 2] = 160; id.data[j + 3] = 110; }
    }
  }
  ctx.putImageData(id, 0, 0);
  return c;
}

let rafPending = false;
function schedule() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    if (S.segDirty) {
      $('#busy').hidden = false;
      setTimeout(() => { compute(); $('#busy').hidden = true; draw(); }, 30);
    } else {
      compute();
      draw();
    }
  });
}

function invalidate(kind = 'result') {
  if (kind === 'seg') S.segDirty = true;
  S.resultDirty = true;
  schedule();
}

// ───────────────────────── 화면 그리기 ─────────────────────────
function viewRect() {
  const { width: W, height: H } = S.original;
  if (S.tool === 'contour' || !S.seg) return { x: 0, y: 0, w: W, h: H };
  const bb = polygonBBox(smoothClosed(S.poly, 4), W, H);
  const cx = (bb.x0 + bb.x1) / 2;
  const cy = (bb.y0 + bb.y1) / 2;
  let w = (bb.x1 - bb.x0) * 1.5;
  let h = (bb.y1 - bb.y0) * 1.9;
  const aspect = 16 / 10;
  if (w / h < aspect) w = h * aspect; else h = w / aspect;
  w = Math.min(W, w);
  h = Math.min(H, h);
  return { x: clamp(cx - w / 2, 0, W - w), y: clamp(cy - h / 2, 0, H - h), w, h };
}

function baseMode() {
  if (S.hold) return 'original';
  if (['contour', 'brushAdd', 'brushErase'].includes(S.tool)) return 'original';
  return S.compare;
}

function draw() {
  if (!S.original || !S.resultCanvas) return;
  const vr = viewRect();
  S.vr = vr;
  const mode = baseMode();
  const side = mode === 'side';
  const gap = side ? Math.round(vr.w * 0.02) : 0;
  const cw = Math.round(side ? vr.w * 2 + gap : vr.w);
  const ch = Math.round(vr.h);
  if (view.width !== cw || view.height !== ch) { view.width = cw; view.height = ch; }
  vctx.setTransform(1, 0, 0, 1, 0, 0);
  vctx.fillStyle = '#05090d';
  vctx.fillRect(0, 0, cw, ch);

  const blit = (src, dx) => vctx.drawImage(src, vr.x, vr.y, vr.w, vr.h, dx, 0, vr.w, vr.h);
  if (mode === 'original') blit(S.originalCanvas, 0);
  else if (mode === 'result') blit(S.resultCanvas, 0);
  else if (mode === 'split') {
    blit(S.resultCanvas, 0);
    const sx = vr.w * S.split;
    vctx.save();
    vctx.beginPath();
    vctx.rect(0, 0, sx, vr.h);
    vctx.clip();
    blit(S.originalCanvas, 0);
    vctx.restore();
  } else if (side) {
    blit(S.originalCanvas, 0);
    blit(S.resultCanvas, vr.w + gap);
  }

  const k = vr.w / Math.max(1, view.getBoundingClientRect().width / (side ? 2 : 1)); // 화면 px → 이미지 px
  const u = k; // 오버레이 기본 단위
  vctx.setTransform(1, 0, 0, 1, -vr.x, -vr.y);

  if (S.guides.mask || ['brushAdd', 'brushErase'].includes(S.tool)) vctx.drawImage(S.maskCanvas, 0, 0);
  drawGuides(u);
  drawToolOverlay(u);

  vctx.setTransform(1, 0, 0, 1, 0, 0);
  if (mode === 'split') {
    const sx = vr.w * S.split;
    vctx.fillStyle = '#fff';
    vctx.fillRect(sx - u, 0, u * 2, vr.h);
    vctx.beginPath();
    vctx.arc(sx, vr.h / 2, 18 * u, 0, Math.PI * 2);
    vctx.fill();
    vctx.fillStyle = '#062a25';
    vctx.font = `bold ${16 * u}px sans-serif`;
    vctx.textAlign = 'center';
    vctx.textBaseline = 'middle';
    vctx.fillText('⇆', sx, vr.h / 2);
    label('치료 전', 12 * u, 12 * u, u);
    label('치료 후', vr.w - 12 * u, 12 * u, u, 'right');
  }
  if (side) {
    label('치료 전', 12 * u, 12 * u, u);
    label('치료 후 (시뮬레이션)', vr.w + gap + 12 * u, 12 * u, u);
  }
}

function label(text, x, y, u, align = 'left') {
  vctx.font = `bold ${18 * u}px sans-serif`;
  vctx.textAlign = align;
  vctx.textBaseline = 'top';
  const m = vctx.measureText(text).width;
  const bx = align === 'right' ? x - m - 10 * u : x;
  vctx.fillStyle = 'rgba(0,0,0,0.55)';
  vctx.fillRect(bx, y, m + 20 * u, 30 * u);
  vctx.fillStyle = '#fff';
  vctx.fillText(text, align === 'right' ? x - 10 * u : x + 10 * u, y + 6 * u);
}

function midX() {
  const bb = S.seg.bbox;
  return S.midlineX ?? (bb.x0 + bb.x1) / 2;
}

function drawGuides(u) {
  const bb = S.seg.bbox;
  const m = midX();
  vctx.save();
  vctx.lineWidth = 2 * u;
  if (S.guides.midline || S.tool === 'midline') {
    vctx.setLineDash([10 * u, 8 * u]);
    vctx.strokeStyle = '#ffd34d';
    vctx.beginPath();
    vctx.moveTo(m, bb.y0 - (bb.y1 - bb.y0) * 0.3);
    vctx.lineTo(m, bb.y1 + (bb.y1 - bb.y0) * 0.3);
    vctx.stroke();
  }
  if (S.guides.golden) {
    // 정중선에서 견치까지: 중절치 1.618 : 측절치 1 : 견치 0.618 (겉보기 폭)
    const half = (bb.x1 - bb.x0) * 0.36;
    const unit = half / (1.618 + 1 + 0.618);
    const marks = [1.618, 2.618, 3.236].map((v) => v * unit);
    vctx.setLineDash([]);
    vctx.strokeStyle = 'rgba(120,200,255,0.9)';
    vctx.fillStyle = 'rgba(120,200,255,0.95)';
    vctx.font = `${13 * u}px sans-serif`;
    vctx.textAlign = 'center';
    const y0 = bb.y0 + (bb.y1 - bb.y0) * 0.1;
    const y1 = bb.y1 - (bb.y1 - bb.y0) * 0.1;
    for (const s of [-1, 1]) {
      marks.forEach((d, i) => {
        vctx.beginPath();
        vctx.moveTo(m + s * d, y0);
        vctx.lineTo(m + s * d, y1);
        vctx.stroke();
        const prev = i ? marks[i - 1] : 0;
        vctx.fillText(['1.618', '1', '0.618'][i], m + s * (prev + d) / 2, y0 - 6 * u);
      });
    }
  }
  if (S.guides.smile) {
    let pts = [];
    if (S.pins.length >= 2) pts = currentTargets().sort((a, b) => a.x - b.x);
    else if (S.t.template.on) pts = layoutTeeth(templateGeometry()).map((t) => ({ x: t.x + t.w / 2, y: t.top + t.h })).sort((a, b) => a.x - b.x);
    if (pts.length >= 2) {
      vctx.setLineDash([]);
      vctx.strokeStyle = '#ff7ab6';
      vctx.lineWidth = 3 * u;
      vctx.beginPath();
      vctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        vctx.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2);
      }
      vctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
      vctx.stroke();
    }
  }
  vctx.restore();
}

function handle(x, y, r, fill, stroke = '#fff') {
  vctx.beginPath();
  vctx.arc(x, y, r, 0, Math.PI * 2);
  vctx.fillStyle = fill;
  vctx.fill();
  vctx.lineWidth = r * 0.25;
  vctx.strokeStyle = stroke;
  vctx.stroke();
}

function drawToolOverlay(u) {
  const r = 10 * u;
  vctx.save();
  if (S.tool === 'contour') {
    const c = smoothClosed(S.poly, 8);
    vctx.lineWidth = 2.5 * u;
    vctx.strokeStyle = '#3ec6b4';
    vctx.beginPath();
    c.forEach((p, i) => (i ? vctx.lineTo(p.x, p.y) : vctx.moveTo(p.x, p.y)));
    vctx.closePath();
    vctx.stroke();
    for (const p of S.poly) handle(p.x, p.y, r, '#3ec6b4');
  }
  const showPins = S.tool === 'pins' || S.tool === 'targets' || (S.t.ortho.on && S.compare !== 'side' && S.tool !== 'view');
  if (showPins) {
    for (const p of S.pins) {
      vctx.strokeStyle = 'rgba(255,255,255,0.8)';
      vctx.lineWidth = 2 * u;
      vctx.beginPath();
      vctx.moveTo(p.sx, p.sy);
      vctx.lineTo(p.tx, p.ty);
      vctx.stroke();
      handle(p.sx, p.sy, r * 0.8, '#ff9a3c');
      handle(p.tx, p.ty, r * 0.8, '#3ec6b4');
    }
  }
  if (S.tool === 'template' && S.t.template.on) {
    const g = templateGeometry();
    handle(g.cx, g.cy, r * 1.3, 'rgba(62,198,180,0.6)');
    vctx.strokeStyle = '#fff';
    vctx.lineWidth = 2 * u;
    vctx.beginPath();
    vctx.moveTo(g.cx - r * 2.5, g.cy); vctx.lineTo(g.cx + r * 2.5, g.cy);
    vctx.moveTo(g.cx, g.cy - r * 2.5); vctx.lineTo(g.cx, g.cy + r * 2.5);
    vctx.stroke();
  }
  if ((S.tool === 'brushAdd' || S.tool === 'brushErase') && S.pointer) {
    vctx.strokeStyle = S.tool === 'brushAdd' ? '#3ce6a0' : '#ff6b6b';
    vctx.lineWidth = 2 * u;
    vctx.beginPath();
    vctx.arc(S.pointer.x, S.pointer.y, brushRadius(), 0, Math.PI * 2);
    vctx.stroke();
  }
  vctx.restore();
}

// ───────────────────────── 포인터 조작 ─────────────────────────
function pxScale() {
  const rect = view.getBoundingClientRect();
  return S.vr.w / (rect.width / (baseMode() === 'side' ? 2 : 1));
}
function brushRadius() { return Number($('#brush-size').value) * pxScale() * 0.5; }

function toImage(e) {
  const rect = view.getBoundingClientRect();
  const sx = (e.clientX - rect.left) * (view.width / rect.width);
  const sy = (e.clientY - rect.top) * (view.height / rect.height);
  return { x: S.vr.x + sx, y: S.vr.y + sy, sx, sy };
}

function paint(p) {
  const { width: w, height: h } = S.original;
  const r = brushRadius();
  const v = S.tool === 'brushAdd' ? 1 : -1;
  const ctx = S.maskCanvas.getContext('2d');
  ctx.save();
  ctx.globalCompositeOperation = v > 0 ? 'source-over' : 'destination-out';
  ctx.fillStyle = 'rgba(60,230,160,0.45)';
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  for (let y = Math.max(0, Math.floor(p.y - r)); y < Math.min(h, Math.ceil(p.y + r)); y++) {
    for (let x = Math.max(0, Math.floor(p.x - r)); x < Math.min(w, Math.ceil(p.x + r)); x++) {
      if ((x - p.x) ** 2 + (y - p.y) ** 2 <= r * r) S.edits[y * w + x] = v;
    }
  }
}

view.addEventListener('pointerdown', (e) => {
  if (!S.original || !S.vr) return;
  view.setPointerCapture(e.pointerId);
  const p = toImage(e);
  const hit = 16 * pxScale();
  const mode = baseMode();
  S.drag = { start: p, moved: false };
  if (mode === 'split' && S.tool === 'view') { S.drag.kind = 'split'; S.split = clamp(p.sx / S.vr.w, 0, 1); draw(); return; }
  switch (S.tool) {
    case 'contour': {
      let best = -1, bd = hit;
      S.poly.forEach((q, i) => { const d = dist(q, p); if (d < bd) { bd = d; best = i; } });
      S.drag.kind = best >= 0 ? 'poly' : 'polyMove';
      S.drag.index = best;
      S.drag.orig = S.poly.map((q) => ({ ...q }));
      break;
    }
    case 'brushAdd':
    case 'brushErase':
      S.drag.kind = 'brush';
      paint(p);
      draw();
      break;
    case 'pins': {
      const i = S.pins.findIndex((q) => Math.hypot(q.sx - p.x, q.sy - p.y) < hit);
      if (i >= 0) { S.drag.kind = 'pin'; S.drag.index = i; }
      else {
        S.pins.push({ sx: p.x, sy: p.y, tx: p.x, ty: p.y });
        S.drag.kind = 'pin';
        S.drag.index = S.pins.length - 1;
        S.drag.created = true;
        S.manualTargets = false;
        invalidate();
      }
      break;
    }
    case 'targets': {
      const i = S.pins.findIndex((q) => Math.hypot(q.tx - p.x, q.ty - p.y) < hit);
      if (i >= 0) { S.drag.kind = 'target'; S.drag.index = i; }
      break;
    }
    case 'template': {
      const g = templateGeometry();
      S.drag.kind = 'template';
      S.drag.offset = { x: g.cx - p.x, y: g.cy - p.y };
      break;
    }
    case 'midline':
      S.drag.kind = 'midline';
      S.midlineX = p.x;
      invalidate();
      break;
    default:
      break;
  }
});

view.addEventListener('pointermove', (e) => {
  if (!S.original || !S.vr) return;
  const p = toImage(e);
  S.pointer = p;
  const d = S.drag;
  if (!d) { if (S.tool.startsWith('brush')) draw(); return; }
  if (Math.hypot(p.x - d.start.x, p.y - d.start.y) > 3 * pxScale()) d.moved = true;
  switch (d.kind) {
    case 'split': S.split = clamp(p.sx / S.vr.w, 0, 1); draw(); break;
    case 'poly': S.poly[d.index] = { x: p.x, y: p.y }; draw(); break;
    case 'polyMove': {
      const dx = p.x - d.start.x, dy = p.y - d.start.y;
      S.poly = d.orig.map((q) => ({ x: q.x + dx, y: q.y + dy }));
      draw();
      break;
    }
    case 'brush': paint(p); draw(); break;
    case 'pin': {
      const q = S.pins[d.index];
      q.sx = p.x; q.sy = p.y;
      invalidate();
      break;
    }
    case 'target': {
      const q = S.pins[d.index];
      q.tx = p.x; q.ty = p.y;
      S.manualTargets = true;
      invalidate();
      break;
    }
    case 'template':
      S.t.template.cx = p.x + d.offset.x;
      S.t.template.cy = p.y + d.offset.y;
      invalidate();
      break;
    case 'midline': S.midlineX = p.x; invalidate(); break;
    default: break;
  }
});

function endDrag() {
  const d = S.drag;
  S.drag = null;
  if (!d) return;
  if (d.kind === 'poly' || d.kind === 'polyMove' || d.kind === 'brush') invalidate('seg');
  if (d.kind === 'pin' && !d.moved && !d.created) {
    S.pins.splice(d.index, 1); // 움직이지 않고 탭하면 삭제
    invalidate();
  }
}
view.addEventListener('pointerup', endDrag);
view.addEventListener('pointercancel', endDrag);
view.addEventListener('pointerleave', () => { S.pointer = null; if (S.tool.startsWith('brush')) draw(); });
view.addEventListener('contextmenu', (e) => e.preventDefault());

// ───────────────────────── 툴바 / 패널 ─────────────────────────
const TOOL_HINTS = {
  view: '',
  contour: '청록색 점을 끌어 입술 안쪽(치아가 보이는 경계)에 맞추세요. 빈 곳을 끌면 전체가 이동합니다.',
  brushAdd: '치아인데 빠진 부분을 칠하세요.',
  brushErase: '잇몸·입술 등 치아가 아닌 부분을 지우세요.',
  pins: '각 치아 끝(절단연) 가운데를 탭해 주황 핀을 찍으세요. 핀을 탭하면 삭제, 끌면 이동.',
  targets: '청록 점(목표 위치)을 끌어 원하는 배열로 직접 조정하세요.',
  template: '화면을 끌어 템플릿(새 치아) 위치를 옮기세요. 십자 표시 = 중절치 절단연 중앙.',
  midline: '얼굴 정중선(코끝·인중 중앙)을 탭하거나 끌어서 지정하세요.',
};

function setTool(tool) {
  S.tool = tool;
  for (const b of $$('[data-tool]')) b.classList.toggle('on', b.dataset.tool === tool);
  $('#tool-hint').textContent = TOOL_HINTS[tool] || '';
  if (tool !== 'view' && (S.compare === 'side' || S.compare === 'split')) setCompare('result');
  if (tool === 'template' && !S.t.template.on) { S.t.template.on = true; syncControls(); invalidate(); }
  if ((tool === 'pins' || tool === 'targets') && !S.t.ortho.on) { S.t.ortho.on = true; syncControls(); invalidate(); }
  schedule();
}
for (const b of $$('[data-tool]')) b.addEventListener('click', () => setTool(S.tool === b.dataset.tool ? 'view' : b.dataset.tool));

function setCompare(mode) {
  S.compare = mode;
  for (const b of $$('#compare-group button')) b.classList.toggle('on', b.dataset.compare === mode);
  if ((mode === 'side' || mode === 'split') && S.tool !== 'view') { S.tool = 'view'; for (const b of $$('[data-tool]')) b.classList.remove('on'); $('#tool-hint').textContent = mode === 'split' ? '화면을 좌우로 끌어 비교하세요.' : ''; }
  else if (mode === 'split') $('#tool-hint').textContent = '화면을 좌우로 끌어 비교하세요.';
  schedule();
}
for (const b of $$('#compare-group button')) b.addEventListener('click', () => setCompare(b.dataset.compare));

for (const b of $$('#guide-group button')) {
  b.addEventListener('click', () => {
    const g = b.dataset.guide;
    S.guides[g] = !S.guides[g];
    b.classList.toggle('on', S.guides[g]);
    if (g === 'smile' && S.guides.smile && S.pins.length < 2 && !S.t.template.on) toast('스마일라인은 교정 핀 또는 보철 템플릿이 있을 때 표시됩니다.');
    schedule();
  });
}

const hold = $('#btn-hold');
hold.addEventListener('pointerdown', () => { S.hold = true; draw(); });
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) hold.addEventListener(ev, () => { if (S.hold) { S.hold = false; draw(); } });

function setTab(name) {
  for (const t of $$('.tab')) t.classList.toggle('on', t.dataset.tab === name);
  for (const t of $$('.tab-body')) t.classList.toggle('on', t.dataset.tab === name);
}
for (const t of $$('.tab')) t.addEventListener('click', () => setTab(t.dataset.tab));

// 쉐이드 선택 목록
for (const id of ['#wh-from', '#wh-to', '#tpl-shade']) {
  const sel = $(id);
  for (const s of SHADES) sel.add(new Option(s.label, s.id));
}
$('#wh-from').addEventListener('change', (e) => { S.t.whitening.from = e.target.value; S.whFromUser = true; invalidate(); });
$('#wh-to').addEventListener('change', (e) => { S.t.whitening.to = e.target.value; invalidate(); });
$('#tpl-shade').addEventListener('change', (e) => { S.t.template.shade = e.target.value; invalidate(); });

function getPath(path) { const [a, b] = path.split('.'); return S.t[a][b]; }
function setPath(path, v) { const [a, b] = path.split('.'); S.t[a][b] = v; }

for (const el of $$('[data-param]')) {
  const ev = el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input';
  el.addEventListener(ev, () => {
    const path = el.dataset.param;
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (el.type === 'range' || el.dataset.num) v = Number(v);
    setPath(path, v);
    const key = path.split('.')[0];
    if (!S.t[key].on) { S.t[key].on = true; syncControls(); }
    if (path === 'ortho.arc') S.manualTargets = false;
    S.preset = null;
    markPreset();
    invalidate();
  });
}
for (const el of $$('[data-on]')) {
  el.addEventListener('change', () => {
    const key = el.dataset.on;
    S.t[key].on = el.checked;
    if (key === 'ortho' && el.checked && !S.pins.length) autoPins();
    S.preset = null;
    markPreset();
    invalidate();
  });
  el.addEventListener('click', (e) => e.stopPropagation()); // details 토글 방지
}

function syncControls() {
  for (const el of $$('[data-param]')) {
    const v = getPath(el.dataset.param);
    if (el.type === 'checkbox') el.checked = !!v; else el.value = String(v);
  }
  for (const el of $$('[data-on]')) el.checked = S.t[el.dataset.on].on;
  $('#wh-from').value = S.t.whitening.from;
  $('#wh-to').value = S.t.whitening.to;
  $('#tpl-shade').value = S.t.template.shade;
  $('#sensitivity').value = S.sensitivity;
}

// 교정 핀
function autoPins() {
  if (!S.seg) compute();
  const pins = suggestPins(S.seg, S.original);
  S.pins = pins.map((p) => ({ sx: p.x, sy: p.y, tx: p.x, ty: p.y }));
  S.manualTargets = false;
  if (!pins.length) toast('치아 위치를 자동으로 찾지 못했습니다. 세부 조정 > "핀 찍기"로 직접 찍어 주세요.', 4500);
  else toast(`치아 ${pins.length}개 위치를 자동 제안했습니다. 세부 조정에서 확인할 수 있어요.`);
  return pins.length;
}
$('#btn-pins-auto').addEventListener('click', () => { autoPins(); S.t.ortho.on = true; syncControls(); invalidate(); });
$('#btn-pins-clear').addEventListener('click', () => { S.pins = []; S.manualTargets = false; invalidate(); });

// 영역 보정
$('#sensitivity').addEventListener('change', (e) => { S.sensitivity = Number(e.target.value); invalidate('seg'); });
$('#btn-reset-edits').addEventListener('click', () => { S.edits?.fill(0); invalidate('seg'); });

// 프리셋
const PRESETS = {
  none: (t) => t,
  whitening: (t) => { t.whitening = { ...t.whitening, on: true, to: 'BL2', strength: 1 }; },
  resin: (t) => { t.resin = { ...t.resin, on: true, stain: 0.85, gap: 0.7 }; },
  laminate: (t) => {
    t.resin = { ...t.resin, on: true, stain: 1, gap: 1 };
    t.veneer = { ...t.veneer, on: true, smooth: 0.7 };
    t.whitening = { ...t.whitening, on: true, to: 'BL1', strength: 1 };
  },
  prosthetic: (t) => { t.template = { ...t.template, on: true }; },
  ortho: (t) => { t.ortho = { ...t.ortho, on: true, strength: 1 }; },
  combo: (t) => {
    t.ortho = { ...t.ortho, on: true, strength: 1 };
    t.resin = { ...t.resin, on: true, stain: 0.6, gap: 0.6 };
    t.whitening = { ...t.whitening, on: true, to: 'BL2', strength: 1 };
  },
};

function applyPreset(name) {
  if (!S.original) return;
  for (const k of Object.keys(S.t)) S.t[k].on = false;
  PRESETS[name](S.t);
  if (S.t.ortho.on && !S.pins.length) autoPins();
  S.preset = name === 'none' ? null : name;
  markPreset();
  syncControls();
  if (S.compare === 'original') setCompare('result');
  invalidate();
}
function markPreset() {
  for (const b of $$('#presets button')) b.classList.toggle('on', b.dataset.preset === S.preset);
}
for (const b of $$('[data-preset]')) b.addEventListener('click', () => applyPreset(b.dataset.preset));

// 기능 현황
$('#cap-list').innerHTML = '';
for (const c of CAPABILITIES) {
  const li = document.createElement('li');
  li.textContent = `${c.status === 'done' ? '✅' : '🤖'} ${c.name}`;
  if (c.note) { const s = document.createElement('small'); s.textContent = c.note; li.append(s); }
  $('#cap-list').append(li);
}

// ───────────────────────── 저장 / 종료 / 다시 찍기 ─────────────────────────
$('#btn-save').addEventListener('click', () => {
  if (!settings.allowDownload || !S.resultCanvas) return;
  const vr = viewRect();
  const gap = 20;
  const c = document.createElement('canvas');
  c.width = Math.round(vr.w * 2 + gap);
  c.height = Math.round(vr.h + 60);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(S.originalCanvas, vr.x, vr.y, vr.w, vr.h, 0, 0, vr.w, vr.h);
  ctx.drawImage(S.resultCanvas, vr.x, vr.y, vr.w, vr.h, vr.w + gap, 0, vr.w, vr.h);
  ctx.fillStyle = '#333';
  ctx.font = `${Math.max(14, Math.round(vr.w / 45))}px sans-serif`;
  ctx.fillText('치료 전  |  치료 후 (시뮬레이션 — 실제 결과와 다를 수 있음)', 12, vr.h + 38);
  c.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `smile-simulation-${new Date().toISOString().slice(0, 10)}.png`; // 환자 식별정보 미포함
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); scrubCanvas(c); }, 1000);
  }, 'image/png');
});

$('#btn-retake').addEventListener('click', () => {
  wipeImageBuffers();
  S = { ...freshState(), t: S.t }; // 치료 설정은 유지, 사진은 삭제
  for (const k of Object.keys(S.t)) S.t[k].on = false;
  $('#btn-camera').click();
});

$('#btn-finish').addEventListener('click', () => wipeAll('상담이 종료되어 사진이 삭제되었습니다.'));

function wipeImageBuffers() {
  scrub(S.original, S.result, S.edits, S.resultMask);
  if (S.seg) scrub(S.seg.mask, S.seg.binary, S.seg.inside, S.seg.insideSoft);
  for (const c of [S.originalCanvas, S.resultCanvas, S.maskCanvas, tplCanvas]) scrubCanvas(c);
  tplCanvas = null;
  S.original = S.result = S.seg = S.originalCanvas = S.resultCanvas = S.maskCanvas = null;
}

function wipeAll(msg) {
  camera.stop();
  wipeImageBuffers();
  scrubCanvas(view);
  S = freshState();
  $('#consent').checked = false;
  $('#btn-camera').disabled = true;
  $('#btn-upload').disabled = true;
  $('#idle-warn').hidden = true;
  for (const b of $$('.on[data-guide], .on[data-tool], #presets .on')) b.classList.remove('on');
  setCompare('result');
  syncControls();
  show('welcome');
  if (msg) toast(msg, 3500);
}

// ───────────────────────── 자동 삭제 ─────────────────────────
new IdleGuard({
  getTimeout: () => settings.idleSec,
  warnSec: 10,
  active: () => S.screen !== 'welcome',
  onWarn: () => { $('#idle-warn').hidden = false; },
  onTick: (n) => { $('#idle-count').textContent = n; },
  onCancelWarn: () => { $('#idle-warn').hidden = true; },
  onTimeout: () => wipeAll('일정 시간 사용이 없어 사진이 자동 삭제되었습니다.'),
});
$('#btn-idle-keep').addEventListener('click', () => { $('#idle-warn').hidden = true; });

document.addEventListener('visibilitychange', () => {
  if (document.hidden && settings.wipeOnHide && S.screen !== 'welcome') wipeAll('화면을 벗어나 사진이 삭제되었습니다.');
});
window.addEventListener('pagehide', () => { camera.stop(); wipeImageBuffers(); });

// ───────────────────────── 직원 설정 ─────────────────────────
function applySettingsUI() {
  $('#set-idle').value = String(settings.idleSec);
  $('#set-download').checked = settings.allowDownload;
  $('#set-mirror').checked = settings.mirror;
  $('#set-hide').checked = settings.wipeOnHide;
  $('#btn-save').hidden = !settings.allowDownload;
}
$('#btn-settings').addEventListener('click', () => { applySettingsUI(); $('#settings').hidden = false; });
$('#btn-settings-close').addEventListener('click', () => {
  settings.idleSec = Number($('#set-idle').value);
  settings.allowDownload = $('#set-download').checked;
  settings.mirror = $('#set-mirror').checked;
  settings.wipeOnHide = $('#set-hide').checked;
  saveSettings(settings);
  applySettingsUI();
  $('#settings').hidden = true;
});
$('#btn-fullscreen').addEventListener('click', () => {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
  else document.exitFullscreen?.();
});

window.addEventListener('resize', () => schedule());
applySettingsUI();
syncControls();

// 디버그/자동화 테스트용 (환자 데이터 접근 없음: 상태 요약만)
window.__smileSim = {
  summary: () => ({ screen: S.screen, hasImage: !!S.original, pins: S.pins.length, tool: S.tool, on: Object.fromEntries(Object.entries(S.t).map(([k, v]) => [k, v.on])) }),
};
