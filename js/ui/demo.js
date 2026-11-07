// 체험·시연용 합성 구강 이미지 (실제 환자 사진이 아님). 누런 색, 정중이개, 틀어진 치아, 착색 포함.

export function makeDemoImage(W = 1200, H = 760) {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const cx = W / 2, cy = H * 0.52, rx = W * 0.36, ry = H * 0.26;

  const skin = ctx.createRadialGradient(cx, cy, 10, cx, cy, W * 0.7);
  skin.addColorStop(0, '#e2b49b');
  skin.addColorStop(1, '#b98468');
  ctx.fillStyle = skin;
  ctx.fillRect(0, 0, W, H);

  const mouth = new Path2D();
  mouth.moveTo(cx - rx, cy);
  mouth.bezierCurveTo(cx - rx * 0.6, cy - ry * 1.05, cx + rx * 0.6, cy - ry * 1.05, cx + rx, cy);
  mouth.bezierCurveTo(cx + rx * 0.55, cy + ry * 1.25, cx - rx * 0.55, cy + ry * 1.25, cx - rx, cy);
  mouth.closePath();

  // 입술
  ctx.save();
  ctx.lineWidth = ry * 0.45;
  ctx.strokeStyle = '#b5525a';
  ctx.lineJoin = 'round';
  ctx.stroke(mouth);
  ctx.restore();

  ctx.save();
  ctx.clip(mouth);
  const dark = ctx.createRadialGradient(cx, cy + ry * 0.4, 5, cx, cy, rx);
  dark.addColorStop(0, '#5a1f27');
  dark.addColorStop(1, '#25090d');
  ctx.fillStyle = dark;
  ctx.fillRect(0, 0, W, H);
  // 잇몸
  ctx.fillStyle = '#c4626b';
  ctx.beginPath();
  ctx.ellipse(cx, cy - ry * 0.95, rx * 0.95, ry * 0.32, 0, 0, Math.PI * 2);
  ctx.fill();
  // 혀
  ctx.fillStyle = '#a8454f';
  ctx.beginPath();
  ctx.ellipse(cx, cy + ry * 0.95, rx * 0.55, ry * 0.4, 0, 0, Math.PI * 2);
  ctx.fill();

  // 상악 치아 10개
  const unit = rx * 0.22;
  const widths = [0.5, 0.58, 0.68, 0.78, 1, 1, 0.78, 0.68, 0.58, 0.5];
  const total = widths.reduce((s, v) => s + v, 0) * unit + unit * 0.12;
  let x = cx - total / 2;
  const top = cy - ry * 0.85;
  widths.forEach((wf, k) => {
    const tw = wf * unit;
    const u = (x + tw / 2 - cx) / (total / 2);
    let edge = cy + ry * 0.15 - u * u * ry * 0.35;
    if (k === 6) edge += ry * 0.12; // 틀어진 측절치
    const depth = Math.abs(u);
    const g = ctx.createLinearGradient(0, top, 0, edge);
    const base = [222 - depth * 50, 200 - depth * 52, 150 - depth * 45];
    g.addColorStop(0, `rgb(${base[0] - 18},${base[1] - 24},${base[2] - 30})`);
    g.addColorStop(0.8, `rgb(${base[0]},${base[1]},${base[2]})`);
    g.addColorStop(1, `rgb(${base[0] - 30},${base[1] - 28},${base[2] - 20})`);
    ctx.fillStyle = g;
    const r = tw * 0.22;
    ctx.beginPath();
    ctx.moveTo(x + 2, top);
    ctx.lineTo(x + tw - 2, top);
    ctx.lineTo(x + tw - 2, edge - r);
    ctx.quadraticCurveTo(x + tw - 2, edge, x + tw - r, edge);
    ctx.lineTo(x + r, edge);
    ctx.quadraticCurveTo(x + 2, edge, x + 2, edge - r);
    ctx.closePath();
    ctx.fill();
    x += tw + (k === 4 ? unit * 0.12 : 0); // 정중이개
  });
  // 착색
  ctx.fillStyle = 'rgba(120,85,45,0.75)';
  ctx.beginPath();
  ctx.ellipse(cx - unit * 1.35, cy - ry * 0.25, unit * 0.12, unit * 0.18, 0, 0, Math.PI * 2);
  ctx.fill();
  // 하악 치아 살짝
  ctx.fillStyle = '#c9b48c';
  for (let k = -3; k < 3; k++) {
    ctx.fillRect(cx + k * unit * 0.62 + 2, cy + ry * 0.62, unit * 0.58, ry * 0.25);
  }
  ctx.restore();

  const img = ctx.getImageData(0, 0, W, H);
  c.width = c.height = 0;
  // 입술 안쪽 윤곽(위·아래 베지어 곡선에서 추출, 입술 두께만큼 안쪽으로)
  const bz = (p0, p1, p2, p3, t) => (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t * t * p2 + t ** 3 * p3;
  const poly = [];
  const inset = 0.97;
  for (let k = 0; k < 7; k++) {
    const t = k / 7;
    const x = bz(cx - rx, cx - rx * 0.6, cx + rx * 0.6, cx + rx, t);
    const y = bz(cy, cy - ry * 1.05, cy - ry * 1.05, cy, t);
    poly.push({ x: cx + (x - cx) * inset, y: cy + (y - cy) * inset });
  }
  for (let k = 0; k < 7; k++) {
    const t = k / 7;
    const x = bz(cx + rx, cx + rx * 0.55, cx - rx * 0.55, cx - rx, t);
    const y = bz(cy, cy + ry * 1.25, cy + ry * 1.25, cy, t);
    poly.push({ x: cx + (x - cx) * inset, y: cy + (y - cy) * inset });
  }
  return { img, guide: { cx, cy, rx: rx * 0.9, ry: ry * 0.9, poly } };
}
