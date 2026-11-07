import test from 'node:test';
import assert from 'node:assert/strict';
import { rgbToLab, labToRgb } from '../js/core/color.js';
import { rasterizePolygon, ellipsePolygon } from '../js/core/geometry.js';
import { segmentTeeth, suggestPins, toothStats } from '../js/core/segmentation.js';
import { computeIdealTargets, mlsAffine } from '../js/core/ortho.js';
import { runPipeline } from '../js/core/pipeline.js';
import { estimateShade, shadeById } from '../js/core/shades.js';
import { layoutTeeth } from '../js/core/template.js';
import { makeMouthImage } from './fixtures.mjs';

test('Lab 왕복 변환 오차 < 1', () => {
  for (const c of [[0, 0, 0], [255, 255, 255], [214, 194, 148], [178, 62, 72], [12, 200, 90]]) {
    const lab = rgbToLab(...c);
    const back = labToRgb(...lab);
    c.forEach((v, i) => assert.ok(Math.abs(v - back[i]) < 1, `${c} -> ${back}`));
  }
  const white = rgbToLab(255, 255, 255);
  assert.ok(Math.abs(white[0] - 100) < 0.1);
});

test('폴리곤 래스터화 면적 ≈ 타원 면적', () => {
  const m = rasterizePolygon(ellipsePolygon(50, 50, 40, 20, 64), 100, 100);
  const area = m.reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(area - Math.PI * 800) / (Math.PI * 800) < 0.03, `area=${area}`);
});

function setup() {
  const f = makeMouthImage();
  const poly = ellipsePolygon(f.cx, f.cy, f.rx - 4, f.ry - 4, 12);
  const seg = segmentTeeth(f.img, poly);
  return { ...f, poly, seg };
}

test('치아 분할: 치아는 포함, 입안 어두운 부분·입술은 제외', () => {
  const { seg, img, teeth } = setup();
  const w = img.width;
  let tp = 0, tot = 0;
  for (const t of teeth) for (let y = t.y0 + 3; y <= t.y1 - 3; y++) for (let x = t.x0 + 3; x <= t.x1 - 3; x++) { tot++; tp += seg.binary[y * w + x]; }
  assert.ok(tp / tot > 0.95, `recall ${tp / tot}`);
  assert.equal(seg.binary[170 * w + 200], 0, '입안 어두운 부분');
  assert.equal(seg.binary[120 * w + 52], 0, '입술');
  assert.ok(seg.stats.L > 70 && seg.stats.b > 15);
});

test('미백: 치아 b*(황색도) 감소, L 증가, 입술 불변', () => {
  const { seg, img } = setup();
  const plan = { whitening: { on: true, from: 'A3', to: 'BL1', strength: 1 } };
  const { image } = runPipeline(img, seg, plan);
  const after = toothStats(image, seg.mask, seg.bbox);
  assert.ok(after.b < seg.stats.b - 10, `b ${seg.stats.b} -> ${after.b}`);
  assert.ok(after.L > seg.stats.L + 5);
  const j = (120 * img.width + 52) * 4;
  assert.deepEqual([...image.data.slice(j, j + 3)], [...img.data.slice(j, j + 3)]);
});

test('레진: 정중이개 틈과 착색이 치아색으로 채워짐', () => {
  const { seg, img } = setup();
  const w = img.width;
  const { image, mask } = runPipeline(img, seg, { resin: { on: true, stain: 1, gap: 1 } });
  const gapIdx = 100 * w + 200; // 중절치 사이
  assert.ok(image.data[gapIdx * 4] > 150, `gap R=${image.data[gapIdx * 4]}`);
  assert.ok(mask[gapIdx] > 0.5);
  const stainIdx = 95 * w + 150;
  assert.ok(image.data[stainIdx * 4] > 190, `stain R=${image.data[stainIdx * 4]}`);
});

test('교정 목표: 좌우 대칭 + 스마일 아크', () => {
  const pins = [{ x: 100, y: 120 }, { x: 140, y: 128 }, { x: 185, y: 130 }, { x: 215, y: 130 }, { x: 262, y: 140 }, { x: 300, y: 121 }];
  const t = computeIdealTargets(pins, 200);
  for (let k = 0; k < 3; k++) {
    assert.ok(Math.abs((200 - t[k].x) - (t[5 - k].x - 200)) < 1e-6, '대칭 x');
    assert.ok(Math.abs(t[k].y - t[5 - k].y) < 1e-6, '대칭 y');
  }
  assert.ok(t[2].y >= t[0].y, '중앙이 더 아래(스마일 아크)');
});

test('MLS: 제어점 위치에서 정확히 원본 좌표로 매핑, 항등 변환 유지', () => {
  const P = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }];
  const out = [0, 0];
  mlsAffine(3, 7, P, P, out);
  assert.ok(Math.abs(out[0] - 3) < 1e-9 && Math.abs(out[1] - 7) < 1e-9);
  const Q = P.map((p) => ({ x: p.x + 5, y: p.y }));
  mlsAffine(10, 0, P, Q, out);
  assert.deepEqual(out, [15, 0]);
});

test('교정 워핑: 틀어진 치아가 목표로 이동', () => {
  const { seg, img } = setup();
  const w = img.width;
  // 우측 측절치(아래로 8px) 절단연 핀을 위로 8px
  const pins = [{ sx: 259, sy: 136, tx: 259, ty: 128 }];
  const { mask } = runPipeline(img, seg, { ortho: { on: true, strength: 1 }, pins });
  assert.ok(seg.binary[134 * w + 259] === 1);
  assert.ok(mask[134 * w + 259] < 0.5, `warped mask=${mask[134 * w + 259]}`);
});

test('핀 자동 제안: 치아 개수 근처, 절단연 근처', () => {
  const { seg, img } = setup();
  const pins = suggestPins(seg, img);
  assert.ok(pins.length >= 4 && pins.length <= 8, `pins=${pins.length}`);
  for (const p of pins) assert.ok(p.y > 115 && p.y < 140, `y=${p.y}`);
});

test('쉐이드 추정 및 템플릿 레이아웃', () => {
  const { seg } = setup();
  assert.ok(estimateShade(seg.stats).id);
  assert.equal(shadeById('nope').id, 'A3');
  const teeth = layoutTeeth({ cx: 200, cy: 130, w: 40, hRatio: 1.2, curve: 0.5, count: 6, golden: true });
  assert.equal(teeth.length, 6);
  const centrals = teeth.filter((t) => t.rank === 0);
  assert.ok(Math.abs(centrals[0].w - 40) < 1e-9);
  const lat = teeth.find((t) => t.rank === 1);
  assert.ok(Math.abs(lat.w / 40 - 0.618) < 1e-9, '황금비율');
});
