// 카메라 미리보기 + 입 가이드 + 카운트다운 촬영. 영상은 메모리에서만 처리된다.

export const GUIDE = { cx: 0.5, cy: 0.56, rx: 0.2, ry: 0.13 }; // 캔버스 비율 기준 타원
const CROP = 1.7; // 가이드 대비 크롭 배율

export class Camera {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.muted = true;
    this.stream = null;
    this.zoom = 1.4;
    this.mirror = true;
    this.raf = 0;
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('이 브라우저/주소에서는 카메라를 쓸 수 없습니다. HTTPS 또는 localhost 로 접속해 주세요.');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    this.canvas.width = this.video.videoWidth || 1280;
    this.canvas.height = this.video.videoHeight || 720;
    const loop = () => { this.draw(true); this.raf = requestAnimationFrame(loop); };
    loop();
  }

  /** 줌/거울 적용한 프레임을 ctx 에 그림 */
  drawFrame(ctx, W, H) {
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw) return;
    const sw = vw / this.zoom;
    const sh = vh / this.zoom;
    ctx.save();
    if (this.mirror) { ctx.translate(W, 0); ctx.scale(-1, 1); }
    ctx.drawImage(this.video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, W, H);
    ctx.restore();
  }

  draw(withGuide) {
    const { ctx, canvas } = this;
    const W = canvas.width;
    const H = canvas.height;
    this.drawFrame(ctx, W, H);
    if (!withGuide) return;
    const g = this.guidePx();
    ctx.save();
    // 가이드 밖은 어둡게
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.ellipse(g.cx, g.cy, g.rx, g.ry, 0, 0, Math.PI * 2);
    ctx.fill('evenodd');
    ctx.setLineDash([18, 12]);
    ctx.lineWidth = Math.max(3, W / 400);
    ctx.strokeStyle = '#3ec6b4';
    ctx.beginPath();
    ctx.ellipse(g.cx, g.cy, g.rx, g.ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    // 정중선 가이드
    ctx.setLineDash([6, 10]);
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.beginPath();
    ctx.moveTo(g.cx, g.cy - g.ry * 1.6);
    ctx.lineTo(g.cx, g.cy + g.ry * 1.6);
    ctx.stroke();
    ctx.restore();
  }

  guidePx() {
    const W = this.canvas.width;
    const H = this.canvas.height;
    return { cx: GUIDE.cx * W, cy: GUIDE.cy * H, rx: GUIDE.rx * W, ry: GUIDE.ry * H };
  }

  /** 가이드 주변을 크롭한 ImageData 와 가이드 타원(크롭 좌표) 반환 */
  capture() {
    const W = this.canvas.width;
    const H = this.canvas.height;
    const off = document.createElement('canvas');
    off.width = W;
    off.height = H;
    const octx = off.getContext('2d', { willReadFrequently: true });
    this.drawFrame(octx, W, H);
    const g = this.guidePx();
    const cw = Math.min(W, Math.round(g.rx * 2 * CROP));
    const ch = Math.min(H, Math.round(g.ry * 2 * CROP * 1.25));
    const x0 = Math.max(0, Math.round(g.cx - cw / 2));
    const y0 = Math.max(0, Math.round(g.cy - ch / 2));
    const img = octx.getImageData(x0, y0, cw, ch);
    octx.clearRect(0, 0, W, H);
    off.width = off.height = 0;
    return { img, guide: { cx: g.cx - x0, cy: g.cy - y0, rx: g.rx * 0.92, ry: g.ry * 0.8 } };
  }

  stop() {
    cancelAnimationFrame(this.raf);
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    this.video.srcObject = null;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
}
