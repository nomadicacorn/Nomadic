// audiodevin CHOP → audiospectrum → analyze → beat / pitch
export class AudioAnalyzer {
  constructor() {
    this.ok = false;
    this.bass = 0; this.mid = 0; this.high = 0; this.level = 0;
    this.beat = 0;          // 0..1 decaying envelope
    this.beatCount = 0;
    this.pitch = 0;         // Hz, 0 = none
    this.pitchConf = 0;
    this.spec = new Uint8Array(256);
    this._max = [0.2, 0.2, 0.2, 0.2];
    this._bassAvg = 0;
    this._lastBeat = 0;
    this._frame = 0;
    this.onBeat = null;
    this.ignoreFreq = 0;    // 공명 합성음 피드백 방지
  }

  attach(ctx, stream) {
    this.ctx = ctx;
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 2048;
    an.smoothingTimeConstant = 0.55;
    an.minDecibels = -92;
    an.maxDecibels = -18;
    src.connect(an);
    this.analyser = an;
    this.freq = new Uint8Array(an.frequencyBinCount);
    this.time = new Float32Array(an.fftSize);
    this.sr = ctx.sampleRate;
    this.ok = true;
  }

  _band(lo, hi) {
    const binHz = this.sr / this.analyser.fftSize;
    const a = Math.max(1, Math.floor(lo / binHz)), b = Math.min(this.freq.length - 1, Math.ceil(hi / binHz));
    let s = 0;
    for (let i = a; i <= b; i++) s += this.freq[i];
    return s / ((b - a + 1) * 255);
  }

  update(now) {
    if (!this.ok) { this.beat *= 0.9; return; }
    const an = this.analyser;
    an.getByteFrequencyData(this.freq);
    const raw = [this._band(20, 160), this._band(160, 2000), this._band(2000, 9000)];
    raw.push(raw[0] * 0.4 + raw[1] * 0.4 + raw[2] * 0.2);
    const out = raw.map((v, i) => {
      // 자동 게인: 조용한 방에서도, 시끄러운 클럽에서도 반응하도록
      this._max[i] = Math.max(v, this._max[i] * 0.997, 0.12);
      const n = Math.min(1, Math.max(0, (v / this._max[i] - 0.25) / 0.75));
      return n * n;
    });
    const k = 0.35;
    this.bass += (out[0] - this.bass) * k;
    this.mid += (out[1] - this.mid) * k;
    this.high += (out[2] - this.high) * k;
    this.level += (out[3] - this.level) * k;

    // 스펙트럼 → 텍스처 (CHOP to TOP)
    const n = this.freq.length;
    for (let i = 0; i < 256; i++) {
      const b = 1 + Math.floor(Math.pow(i / 255, 2.0) * (n * 0.45));
      this.spec[i] = this.freq[b];
    }

    // beat: 저음 에너지 플럭스
    this._bassAvg = this._bassAvg * 0.94 + raw[0] * 0.06;
    if (raw[0] > this._bassAvg * 1.22 + 0.04 && now - this._lastBeat > 0.22 && out[0] > 0.25) {
      this._lastBeat = now;
      this.beat = 1;
      this.beatCount++;
      this.onBeat && this.onBeat(out[0]);
    } else {
      this.beat *= 0.86;
    }

    if ((this._frame++ % 3) === 0) this._detectPitch();
  }

  _detectPitch() {
    const buf = this.time;
    this.analyser.getFloatTimeDomainData(buf);
    const N = 1024;
    let rms = 0;
    for (let i = 0; i < N; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / N);
    if (rms < 0.012) { this.pitchConf *= 0.8; if (this.pitchConf < 0.3) this.pitch = 0; return; }
    const sr = this.sr;
    const minLag = Math.floor(sr / 1100), maxLag = Math.min(N - 64, Math.floor(sr / 70));
    let r0 = 0;
    for (let i = 0; i < N; i++) r0 += buf[i] * buf[i];
    const c = new Float32Array(maxLag + 2);
    let best = 0;
    for (let lag = minLag; lag <= maxLag + 1; lag++) {
      let s = 0;
      const m = N - lag;
      for (let i = 0; i < m; i++) s += buf[i] * buf[i + lag];
      c[lag] = (s / r0) * (N / m);
      if (c[lag] > best && lag <= maxLag) best = c[lag];
    }
    if (best < 0.55) { this.pitchConf *= 0.8; if (this.pitchConf < 0.3) this.pitch = 0; return; }
    // 옥타브 오류 방지: 최대값의 90%를 넘는 첫 번째 국소 최대
    let lag = -1;
    for (let l = minLag + 1; l < maxLag; l++) {
      if (c[l] > best * 0.9 && c[l] >= c[l - 1] && c[l] >= c[l + 1]) { lag = l; break; }
    }
    if (lag < 0) return;
    const a = c[lag - 1], b = c[lag], d = c[lag + 1];
    const shift = (a - d) / (2 * (a - 2 * b + d) || 1);
    const f = sr / (lag + (isFinite(shift) ? shift : 0));
    if (this.ignoreFreq && Math.abs(Math.log2(f / this.ignoreFreq)) < 0.04) return;
    this.pitch = this.pitch ? this.pitch + (f - this.pitch) * 0.5 : f;
    this.pitchConf = best;
  }
}

// ------------------------------------------------------------------------
// RESONANCE — 시각이 다시 소리가 되는 역방향 루프.
// 터치디자이너는 자극을 받아 그림을 만든다. 여기서는 그림의 상태가 다시 소리를 만들고,
// 당신의 목소리에 5도 화음으로 대답한다.
const SCALES = [
  [0, 2, 3, 7, 9],     // nebula: dorian-ish pentatonic
  [0, 3, 5, 7, 10],    // mirror: minor pentatonic
  [0, 2, 4, 7, 11],    // orbit: lydian color
  [0, 1, 5, 7, 8],     // pulsar: in-sen (일본 음계풍) — 낯선 우주
];
const ROOTS = [45, 50, 41, 47]; // A2, D3, F2, B2

export class Resonance {
  constructor(ctx) {
    this.ctx = ctx;
    this.enabled = false;
    this.mode = 0;
    const out = ctx.createGain(); out.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.ratio.value = 4;
    out.connect(comp); comp.connect(ctx.destination);
    this.recDest = ctx.createMediaStreamDestination();
    comp.connect(this.recDest);
    this.out = out;

    const bus = ctx.createGain();
    const dry = ctx.createGain(); dry.gain.value = 0.55;
    const wet = ctx.createGain(); wet.gain.value = 0.8;
    const verb = ctx.createConvolver();
    verb.buffer = this._impulse(5.5);
    bus.connect(dry); dry.connect(out);
    bus.connect(verb); verb.connect(wet); wet.connect(out);
    this.bus = bus;

    // drone
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass'; filt.frequency.value = 400; filt.Q.value = 5;
    const droneG = ctx.createGain(); droneG.gain.value = 0.0;
    filt.connect(droneG); droneG.connect(bus);
    this.filt = filt; this.droneG = droneG;
    this.drone = [0, 7, 12, 19].map((iv, i) => {
      const o = ctx.createOscillator();
      o.type = i % 2 ? 'triangle' : 'sawtooth';
      o.detune.value = (i - 1.5) * 6;
      const g = ctx.createGain(); g.gain.value = i < 2 ? 0.09 : 0.05;
      o.connect(g); g.connect(filt);
      o.start();
      return { o, iv };
    });
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
    const lfoG = ctx.createGain(); lfoG.gain.value = 180;
    lfo.connect(lfoG); lfoG.connect(filt.frequency); lfo.start();

    // harmonizer (목소리에 대답하는 성가대)
    const h = ctx.createOscillator(); h.type = 'sine';
    const h2 = ctx.createOscillator(); h2.type = 'sine';
    const hg = ctx.createGain(); hg.gain.value = 0;
    h.connect(hg); h2.connect(hg); hg.connect(bus);
    h.start(); h2.start();
    this.harm = { h, h2, hg };
    this._setRoot(0);
  }

  _impulse(sec) {
    const ctx = this.ctx, len = Math.floor(ctx.sampleRate * sec);
    const b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
    }
    return b;
  }

  static mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  quantize(freq) {
    const midi = 69 + 12 * Math.log2(freq / 440);
    const root = ROOTS[this.mode] % 12, scale = SCALES[this.mode];
    let best = midi, bd = 99;
    for (let o = -1; o <= 9; o++) for (const s of scale) {
      const m = o * 12 + root + s;
      const d = Math.abs(m - midi);
      if (d < bd) { bd = d; best = m; }
    }
    return best;
  }

  _setRoot(mode) {
    this.mode = mode;
    const t = this.ctx.currentTime;
    for (const d of this.drone) {
      d.o.frequency.setTargetAtTime(Resonance.mtof(ROOTS[mode] - 12 + d.iv), t, 1.2);
    }
  }

  setMode(mode) { if (mode !== this.mode) this._setRoot(mode); }

  setEnabled(on) {
    this.enabled = on;
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setTargetAtTime(on ? 0.6 : 0, t, 0.6);
    this.droneG.gain.setTargetAtTime(on ? 0.5 : 0, t, 1.5);
  }

  /** @param s {energy, motion, pitch, voice, bass} */
  update(s) {
    if (!this.enabled) return;
    const t = this.ctx.currentTime;
    this.filt.frequency.setTargetAtTime(220 + s.energy * 1600 + s.motion * 1400, t, 0.25);
    const { h, h2, hg } = this.harm;
    if (s.pitch > 0) {
      const m = this.quantize(s.pitch);
      // 5도 위 + 옥타브 아래 3도: 당신의 목소리에 화음을 얹는다
      const f1 = Resonance.mtof(m + 7), f2 = Resonance.mtof(this.quantize(Resonance.mtof(m - 8)));
      h.frequency.setTargetAtTime(f1, t, 0.08);
      h2.frequency.setTargetAtTime(f2, t, 0.12);
      hg.gain.setTargetAtTime(Math.min(0.12, s.voice * 0.25), t, 0.15);
      this.harmFreq = f1;
    } else {
      hg.gain.setTargetAtTime(0, t, 0.5);
      this.harmFreq = 0;
    }
  }

  // 터치 = 별을 연주하는 악기
  bell(y01, vel = 1) {
    if (!this.enabled) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const base = ROOTS[this.mode] + 12;
    const scale = SCALES[this.mode];
    const step = Math.floor((1 - y01) * 12);
    const m = base + Math.floor(step / scale.length) * 12 + scale[step % scale.length];
    const f = Resonance.mtof(m);
    const car = ctx.createOscillator(), mod = ctx.createOscillator();
    const mg = ctx.createGain(), g = ctx.createGain();
    car.frequency.value = f; mod.frequency.value = f * 3.51;
    mg.gain.setValueAtTime(f * 2.2 * vel, t);
    mg.gain.exponentialRampToValueAtTime(1, t + 1.8);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18 * vel, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 3.2);
    mod.connect(mg); mg.connect(car.frequency); car.connect(g); g.connect(this.bus);
    car.start(t); mod.start(t); car.stop(t + 3.3); mod.stop(t + 3.3);
  }

  // 초신성 = 노이즈 스웰
  swell() {
    if (!this.enabled) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const len = ctx.sampleRate * 3;
    const b = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource(); src.buffer = b;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 3;
    bp.frequency.setValueAtTime(3000, t);
    bp.frequency.exponentialRampToValueAtTime(120, t + 2.8);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.9);
    src.connect(bp); bp.connect(g); g.connect(this.bus);
    src.start(t); src.stop(t + 3);
  }
}
