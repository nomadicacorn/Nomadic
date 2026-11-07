// 개인정보 보호 유틸: 무입력 자동 삭제 타이머, 메모리 버퍼 0으로 덮어쓰기, 설정(사진 제외) 저장.

const KEY = 'smilesim.settings.v1';
export const DEFAULT_SETTINGS = { idleSec: 180, allowDownload: false, mirror: true, wipeOnHide: false };

export function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* 저장 불가 환경 무시 */ }
}

/** 타입드 배열/ImageData 를 0으로 덮어써 메모리에서 흔적을 지움 */
export function scrub(...items) {
  for (const it of items) {
    if (!it) continue;
    if (it.data && it.data.fill) it.data.fill(0);
    else if (it.fill && ArrayBuffer.isView(it)) it.fill(0);
  }
}

export function scrubCanvas(canvas) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  canvas.width = 1;
  canvas.height = 1;
}

/**
 * 무입력 감시. active() 가 true 일 때만 동작.
 * timeoutSec 경과 시 경고(warnSec 카운트다운) 후 onTimeout.
 */
export class IdleGuard {
  constructor({ getTimeout, warnSec = 10, active, onWarn, onTick, onCancelWarn, onTimeout }) {
    Object.assign(this, { getTimeout, warnSec, active, onWarn, onTick, onCancelWarn, onTimeout });
    this.last = Date.now();
    this.warning = false;
    const bump = () => this.bump();
    for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']) {
      window.addEventListener(ev, bump, { passive: true, capture: true });
    }
    this.timer = setInterval(() => this.check(), 1000);
  }

  bump() {
    this.last = Date.now();
    if (this.warning) { this.warning = false; this.onCancelWarn?.(); }
  }

  check() {
    if (!this.active()) { this.last = Date.now(); return; }
    const idle = (Date.now() - this.last) / 1000;
    const t = this.getTimeout();
    if (idle >= t + this.warnSec) {
      this.warning = false;
      this.last = Date.now();
      this.onTimeout();
    } else if (idle >= t) {
      if (!this.warning) { this.warning = true; this.onWarn?.(); }
      this.onTick?.(Math.ceil(t + this.warnSec - idle));
    }
  }
}
