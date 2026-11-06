// 손가락, 기울기, 흔들기 — 터치디자이너의 Multi Touch In / OSC 대신 몸에 붙은 센서들
export class Input {
  constructor(el) {
    this.el = el;
    this.pointers = new Map();     // id → {x, y, t0, x0, y0}
    this.releases = [];            // {x, y, t, s} 화이트홀 잔향
    this.tilt = { x: 0, y: 0 };    // -1..1
    this.hasGyro = false;
    this.pinch = 0;                // 누적 핀치 (feedback zoom)
    this.onTap = null;
    this.onDoubleTap = null;
    this.onShake = null;
    this.onRelease = null;
    this._lastTap = { t: 0, x: 0, y: 0 };
    this._base = null;
    this._lastShake = 0;
    this._pinchD = 0;
    this.lastActivity = 0;

    el.addEventListener('pointerdown', e => this._down(e));
    el.addEventListener('pointermove', e => this._move(e));
    el.addEventListener('pointerup', e => this._up(e));
    el.addEventListener('pointercancel', e => this._up(e));
    el.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') this._up(e); });
    el.addEventListener('contextmenu', e => e.preventDefault());
    // desktop: 마우스 위치 = 시차
    window.addEventListener('mousemove', e => {
      if (this.hasGyro) return;
      this.tilt.x = (e.clientX / innerWidth - 0.5) * 1.2;
      this.tilt.y = (e.clientY / innerHeight - 0.5) * 1.2;
    });
  }

  async requestSensors() {
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) {
        await DeviceOrientationEvent.requestPermission();
      }
      if (typeof DeviceMotionEvent !== 'undefined' && DeviceMotionEvent.requestPermission) {
        await DeviceMotionEvent.requestPermission();
      }
    } catch (e) { /* 거부되어도 계속 */ }
    window.addEventListener('deviceorientation', e => this._orient(e));
    window.addEventListener('devicemotion', e => this._motion(e));
  }

  _orient(e) {
    if (e.beta == null) return;
    this.hasGyro = true;
    if (!this._base) this._base = { b: e.beta, g: e.gamma };
    // 기준 자세를 천천히 따라가서, 오래 기울인 자세가 새로운 '수평'이 된다
    this._base.b += (e.beta - this._base.b) * 0.002;
    this._base.g += (e.gamma - this._base.g) * 0.002;
    const cl = v => Math.max(-1, Math.min(1, v));
    this.tilt.x = cl((e.gamma - this._base.g) / 35);
    this.tilt.y = cl((e.beta - this._base.b) / 35);
  }

  _motion(e) {
    const a = e.acceleration;
    if (!a || a.x == null) return;
    const m = Math.hypot(a.x, a.y, a.z);
    const now = performance.now();
    if (m > 17 && now - this._lastShake > 1200) {
      this._lastShake = now;
      this.lastActivity = now;
      this.onShake && this.onShake(Math.min(1, m / 30));
    }
  }

  _norm(e) {
    const r = this.el.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  }

  _down(e) {
    if (this.pointers.size >= 5) return;
    try { this.el.setPointerCapture(e.pointerId); } catch (_) {}
    const p = this._norm(e), now = performance.now();
    this.lastActivity = now;
    this.pointers.set(e.pointerId, { ...p, t0: now, x0: p.x, y0: p.y });
    const lt = this._lastTap;
    if (now - lt.t < 320 && Math.hypot(p.x - lt.x, p.y - lt.y) < 0.08) {
      this.onDoubleTap && this.onDoubleTap(p);
      lt.t = 0;
    } else {
      this._lastTap = { t: now, ...p };
      this.onTap && this.onTap(p);
    }
    if (this.pointers.size === 2) this._pinchD = this._pinchDist();
  }

  _move(e) {
    const ptr = this.pointers.get(e.pointerId);
    if (!ptr) return;
    Object.assign(ptr, this._norm(e));
    this.lastActivity = performance.now();
    if (this.pointers.size === 2) {
      const d = this._pinchDist();
      this.pinch += (d - this._pinchD) * 3;
      this.pinch = Math.max(-1.5, Math.min(1.5, this.pinch));
      this._pinchD = d;
    }
  }

  _up(e) {
    const ptr = this.pointers.get(e.pointerId);
    if (!ptr) return;
    const now = performance.now();
    const held = (now - ptr.t0) / 1000;
    this.pointers.delete(e.pointerId);
    // 오래 누른 블랙홀을 놓으면 → 화이트홀 폭발
    if (held > 0.6) this.releases.push({ x: ptr.x, y: ptr.y, t: now, s: Math.min(4, held * 2) });
    this.onRelease && this.onRelease(ptr, held);
  }

  _pinchDist() {
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  /** → Float32Array(20) uHoles, screen uv (y up) */
  holesUniform(now) {
    const out = new Float32Array(20);
    let i = 0;
    for (const p of this.pointers.values()) {
      if (i >= 5) break;
      const held = (now - p.t0) / 1000;
      out.set([p.x, 1 - p.y, Math.min(held * 1.6, 4), 1], i++ * 4);
    }
    for (const r of this.releases) {
      if (i >= 5) break;
      const k = 1 - (now - r.t) / 350;
      out.set([r.x, 1 - r.y, -r.s * 1.5 * k, 1], i++ * 4);
    }
    return out;
  }

  /** → Float32Array(20) uTouch, world coords */
  touchUniform(aspect, K, now) {
    const out = new Float32Array(20);
    let i = 0;
    for (const p of this.pointers.values()) {
      if (i >= 5) break;
      const held = (now - p.t0) / 1000;
      out[i * 4] = (p.x * 2 - 1) * aspect / K;
      out[i * 4 + 1] = (1 - p.y * 2) / K;
      out[i * 4 + 2] = Math.min(1 + held * 1.8, 5);
      out[i * 4 + 3] = 1;
      i++;
    }
    this.releases = this.releases.filter(r => now - r.t < 350);
    for (const r of this.releases) {
      if (i >= 5) break;
      out[i * 4] = (r.x * 2 - 1) * aspect / K;
      out[i * 4 + 1] = (1 - r.y * 2) / K;
      out[i * 4 + 2] = -r.s * 3;
      out[i * 4 + 3] = 1;
      i++;
    }
    return out;
  }
}
