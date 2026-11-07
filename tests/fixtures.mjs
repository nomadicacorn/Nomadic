// 테스트용 합성 구강 이미지 (실제 환자 사진 사용 금지)
export function makeMouthImage() {
  const w = 400, h = 240;
  const data = new Uint8ClampedArray(w * h * 4);
  const set = (x, y, c) => { const j = (y * w + x) * 4; data[j] = c[0]; data[j + 1] = c[1]; data[j + 2] = c[2]; data[j + 3] = 255; };
  const cx = 200, cy = 120, rx = 150, ry = 70;
  // 치아: 중절치 사이 8px 정중이개, 우측 측절치 8px 아래로 틀어짐
  const teeth = [];
  const widths = [26, 32, 40, 40, 32, 26];
  let x = 200 - 4 - 26 - 32 - 40;
  widths.forEach((tw, k) => {
    teeth.push({ x0: x, x1: x + tw - 2, y0: 62, y1: 128 + (k === 4 ? 8 : 0) });
    x += tw + (k === 2 ? 8 : 0);
  });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
    let c = [222, 172, 150];
    if (d <= 1.25) c = [178, 62, 72];
    if (d <= 1) {
      c = [55, 18, 24];
      for (const t of teeth) if (x >= t.x0 && x <= t.x1 && y >= t.y0 && y <= t.y1) c = [214, 194, 148];
      // 착색
      if ((x - 150) ** 2 + (y - 95) ** 2 < 16) c = [140, 110, 70];
    }
    set(x, y, c);
  }
  return { img: { width: w, height: h, data }, cx, cy, rx, ry, teeth };
}
