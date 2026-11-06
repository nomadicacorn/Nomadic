import * as S from './shaders.js';
import { createProgram, createTexture, createFBO, deleteFBO } from './gl.js';
import { AudioAnalyzer, Resonance } from './audio.js';
import { Input } from './input.js';

const MODES = [
  { id: 'nebula', name: 'NEBULA', ko: '성운', hint: '소리가 성운을 부풀리고, 움직임이 별가루를 흩뿌린다' },
  { id: 'mirror', name: 'MIRROR', ko: '성좌 거울', hint: '당신의 얼굴이 별들의 깊이가 된다 · 폰을 기울여 돌아보기' },
  { id: 'orbit', name: 'ORBIT', ko: '궤도', hint: '길게 눌러 블랙홀을 만들고, 놓으면 화이트홀' },
  { id: 'pulsar', name: 'PULSAR', ko: '펄서', hint: '목소리의 주파수가 행성의 껍질을 울린다' },
];
const DECAY = [0.945, 0.72, 0.955, 0.9];
const EXPOSURE = [1.3, 1.0, 0.9, 1.0];
const TRAIL_GAIN = 5.0; // 피드백 정상상태 밝기 = 장면 × TRAIL_GAIN
const K = 0.85; // world → ndc scale at z=0

const $ = s => document.querySelector(s);
const canvas = $('#c');
const gl = canvas.getContext('webgl2', {
  antialias: false, alpha: false, depth: false, stencil: false,
  premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance',
});

function fail(msg) {
  $('#start').classList.add('hidden');
  const f = $('#fail'); f.textContent = msg; f.classList.remove('hidden');
}

if (!gl) {
  fail('이 기기는 WebGL2를 지원하지 않아요. 최신 Chrome / Safari에서 열어주세요.');
  throw new Error('no webgl2');
}
const extF = gl.getExtension('EXT_color_buffer_float');
const extH = gl.getExtension('EXT_color_buffer_half_float');
gl.getExtension('OES_texture_float_linear');

const isMobile = matchMedia('(pointer: coarse)').matches;
let PSIZE = isMobile ? 256 : 384;
let quality = isMobile ? 0.72 : 0.9;

// ---------------------------------------------------------------- programs
const P = {
  cam: createProgram(gl, S.FULLSCREEN_VS, S.CAM_FS),
  sim: createProgram(gl, S.FULLSCREEN_VS, S.SIM_FS),
  pts: createProgram(gl, S.POINTS_VS, S.POINTS_FS),
  fb: createProgram(gl, S.FULLSCREEN_VS, S.FEEDBACK_FS),
  blur: createProgram(gl, S.FULLSCREEN_VS, S.BLUR_FS),
  fin: createProgram(gl, S.FULLSCREEN_VS, S.FINAL_FS),
};
const vao = gl.createVertexArray();
gl.bindVertexArray(vao);

// ---------------------------------------------------------------- resources
const F32 = { internal: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT, filter: gl.NEAREST };
const F16 = { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, filter: gl.LINEAR };
const U8 = { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, filter: gl.LINEAR };

function makeSim(size) {
  const N = size * size;
  const pos = new Float32Array(N * 4), vel = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    pos[i * 4] = (Math.random() - 0.5) * 3;
    pos[i * 4 + 1] = (Math.random() - 0.5) * 3;
    pos[i * 4 + 2] = (Math.random() - 0.5) * 1.5;
    pos[i * 4 + 3] = Math.random();
    vel[i * 4 + 3] = 0.001 + Math.random();
  }
  const tryFmt = fmt => {
    const fbs = [0, 1].map(() => {
      const opts = { ...fmt, filter: gl.NEAREST, type: gl.FLOAT };
      return createFBO(gl, [createTexture(gl, size, size, { ...opts, data: pos }), createTexture(gl, size, size, { ...opts, data: vel })]);
    });
    if (fbs.every(f => f.ok)) return fbs;
    fbs.forEach(f => deleteFBO(gl, f));
    return null;
  };
  return (extF && tryFmt(F32)) || tryFmt(F16);
}

let sim = makeSim(PSIZE), simI = 0;
if (!sim) { fail('이 기기의 GPU가 부동소수점 렌더링을 지원하지 않아요.'); throw new Error('no float fbo'); }

let camW = 160, camH = 120, cam = null, camI = 0;
function makeCam(w, h) {
  if (cam) cam.forEach(f => deleteFBO(gl, f));
  camW = w; camH = h;
  cam = [0, 1].map(() => createFBO(gl, [createTexture(gl, w, h, U8)]));
}
makeCam(160, 120);

const videoTex = createTexture(gl, 1, 1, { ...U8, data: new Uint8Array(4) });
gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
const specTex = createTexture(gl, 256, 1, { internal: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE, data: new Uint8Array(256) });

let W = 0, H = 0, scene = null, fb = null, fbI = 0, bloomA = null, bloomB = null;
let fbFmt = F16;
function makeTargets() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  W = Math.max(2, Math.floor(innerWidth * dpr * quality));
  H = Math.max(2, Math.floor(innerHeight * dpr * quality));
  canvas.width = W; canvas.height = H;
  [scene, bloomA, bloomB].forEach(f => deleteFBO(gl, f));
  if (fb) fb.forEach(f => deleteFBO(gl, f));
  const mk = (w, h) => {
    let f = createFBO(gl, [createTexture(gl, w, h, fbFmt)]);
    if (!f.ok && fbFmt !== U8) { deleteFBO(gl, f); fbFmt = U8; f = createFBO(gl, [createTexture(gl, w, h, fbFmt)]); }
    return f;
  };
  scene = mk(W, H);
  fb = [mk(W, H), mk(W, H)];
  const bw = Math.max(2, W >> 2), bh = Math.max(2, H >> 2);
  bloomA = mk(bw, bh); bloomB = mk(bw, bh);
  for (const f of fb) { gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
}
makeTargets();
let resizeT = 0;
addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(makeTargets, 150); });

// ---------------------------------------------------------------- state
const state = {
  mode: 0,
  modeW: [1, 0, 0, 0],
  hue: 0.6,
  burst: 0, flash: 0,
  dream: 0, dreamModeT: 0,
  lastSound: 0, lastMotion: 0,
  motion: 0,
  facing: 'user',
  hasVideo: false,
  synthOn: false,
  hud: !isMobile || innerWidth > 500,
  autoYaw: 0,
  zoomKick: 0,
};

const audio = new AudioAnalyzer();
let actx = null, reso = null;
const input = new Input(canvas);
const video = $('#video');

// ---------------------------------------------------------------- media
let stream = null;
async function startMedia(withAudio) {
  const vc = { facingMode: state.facing, width: { ideal: 640 }, height: { ideal: 480 } };
  const ac = { echoCancellation: true, noiseSuppression: false, autoGainControl: false };
  let s = null;
  try { s = await navigator.mediaDevices.getUserMedia({ video: vc, audio: withAudio ? ac : false }); }
  catch (e) {
    // 하나만 허용된 경우를 위해 따로 시도
    s = new MediaStream();
    try { (await navigator.mediaDevices.getUserMedia({ video: vc })).getTracks().forEach(t => s.addTrack(t)); } catch (_) {}
    if (withAudio) try { (await navigator.mediaDevices.getUserMedia({ audio: ac })).getTracks().forEach(t => s.addTrack(t)); } catch (_) {}
  }
  const vt = s.getVideoTracks()[0];
  if (vt) {
    if (stream) stream.getVideoTracks().forEach(t => t.stop());
    stream = new MediaStream([vt]);
    video.srcObject = stream;
    await video.play().catch(() => {});
    state.hasVideo = true;
  }
  const at = s.getAudioTracks()[0];
  if (at && !audio.ok) audio.attach(actx, new MediaStream([at]));
  status();
}

function status() {
  const parts = [];
  if (!state.hasVideo) parts.push('카메라 없음 — 가상의 형상으로 대체');
  if (!audio.ok) parts.push('마이크 없음 — 꿈꾸는 모드가 대신 연주');
  $('#status').textContent = parts.join(' · ');
}

// 전역 움직임량 (CPU): 아주 작은 캔버스에서 프레임 차분
const mc = document.createElement('canvas'); mc.width = 24; mc.height = 18;
const mctx = mc.getContext('2d', { willReadFrequently: true });
let mPrev = null;
function measureMotion() {
  if (!state.hasVideo || video.readyState < 2) return;
  mctx.drawImage(video, 0, 0, 24, 18);
  const d = mctx.getImageData(0, 0, 24, 18).data;
  if (mPrev) {
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += Math.abs(d[i + 1] - mPrev[i + 1]);
    const m = s / (d.length / 4) / 255;
    state.motion += (Math.min(1, m * 8) - state.motion) * 0.4;
  }
  mPrev = new Uint8ClampedArray(d);
}

// ---------------------------------------------------------------- events
function setMode(i, quiet) {
  state.mode = (i + 4) % 4;
  document.querySelectorAll('.mode').forEach((b, j) => b.classList.toggle('on', j === state.mode));
  reso && reso.setMode(state.mode);
  if (!quiet) toast(`${MODES[state.mode].name} · ${MODES[state.mode].ko}`, MODES[state.mode].hint);
}

function supernova(power = 1) {
  state.burst = Math.max(state.burst, power);
  state.flash = 1;
  state.zoomKick = 0.04 * power;
  reso && reso.swell();
  navigator.vibrate && navigator.vibrate([20, 40, 60]);
}

audio.onBeat = v => {
  state.flash = Math.max(state.flash, v);
  if (v > 0.8 && navigator.vibrate) navigator.vibrate(10);
};

input.onTap = p => { reso && reso.bell(p.y, 0.8); };
input.onDoubleTap = () => supernova(1);
input.onShake = v => supernova(0.6 + v);
input.onRelease = (p, held) => { if (held > 0.6) { reso && reso.bell(p.y, 1); state.flash = 0.8; } };

addEventListener('keydown', e => {
  if (e.key >= '1' && e.key <= '4') setMode(+e.key - 1);
  if (e.key === ' ') supernova(1);
  if (e.key === 'h') toggleHud();
});

let toastT = 0;
function toast(title, sub) {
  const t = $('#toast');
  t.innerHTML = `<b>${title}</b><span>${sub || ''}</span>`;
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), 2800);
}

function toggleHud() {
  state.hud = !state.hud;
  $('#hud').classList.toggle('hidden', !state.hud);
  $('#b-hud').classList.toggle('on', state.hud);
}

// ---------------------------------------------------------------- UI
const modeBar = $('#modes');
MODES.forEach((m, i) => {
  const b = document.createElement('button');
  b.className = 'mode' + (i === 0 ? ' on' : '');
  b.innerHTML = `<i class="g g${i}"></i><span>${m.ko}</span>`;
  b.onclick = () => setMode(i);
  modeBar.appendChild(b);
});

$('#b-sound').onclick = () => {
  if (!reso) return;
  state.synthOn = !state.synthOn;
  reso.setEnabled(state.synthOn);
  $('#b-sound').classList.toggle('on', state.synthOn);
  toast(state.synthOn ? 'RESONANCE ON' : 'RESONANCE OFF',
    state.synthOn ? '우주가 대답합니다 · 이어폰을 쓰면 더 깨끗하게 들려요' : '');
};
$('#b-flip').onclick = async () => {
  state.facing = state.facing === 'user' ? 'environment' : 'user';
  await startMedia(false);
  toast(state.facing === 'user' ? '전면 카메라' : '후면 카메라', '');
};
$('#b-hud').onclick = toggleHud;
$('#b-snap').onclick = () => { snapRequested = true; };
$('#b-rec').onclick = toggleRecord;
$('#hud').classList.toggle('hidden', !state.hud);
$('#b-hud').classList.toggle('on', state.hud);

// 기록: 캔버스 + 공명 사운드를 영상으로
let rec = null, recChunks = [];
function pickMime() {
  const c = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
  return c.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}
function toggleRecord() {
  if (rec) { rec.stop(); return; }
  if (!window.MediaRecorder || !canvas.captureStream) { toast('녹화 미지원', '이 브라우저는 캔버스 녹화를 지원하지 않아요'); return; }
  const s = canvas.captureStream(30);
  if (reso) reso.recDest.stream.getAudioTracks().forEach(t => s.addTrack(t));
  const mime = pickMime();
  rec = new MediaRecorder(s, mime ? { mimeType: mime, videoBitsPerSecond: 8e6 } : undefined);
  recChunks = [];
  rec.ondataavailable = e => e.data.size && recChunks.push(e.data);
  rec.onstop = () => {
    const type = rec.mimeType || 'video/webm';
    const blob = new Blob(recChunks, { type });
    saveBlob(blob, `orbita-${Date.now()}.${type.includes('mp4') ? 'mp4' : 'webm'}`);
    rec = null;
    $('#b-rec').classList.remove('on');
  };
  rec.start(500);
  $('#b-rec').classList.add('on');
  toast('REC', '다시 누르면 저장됩니다');
}

let snapRequested = false;
async function saveBlob(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'ÓRBITA' }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ---------------------------------------------------------------- HUD (TouchDesigner network)
const hud = $('#hud');
const OPS = [
  ['chop', 'audiodevin1', 'lvl'],
  ['chop', 'spectrum1', 'spec'],
  ['chop', 'bands1', 'bands'],
  ['chop', 'beat1', 'beat'],
  ['chop', 'pitch1', 'pitch'],
  ['top', 'videodevin1', 'motion'],
  ['chop', 'touch1 · tilt1', 'touch'],
  ['sop', 'particles1', 'parts'],
  ['top', 'feedback1', 'fb'],
  ['comp', 'dream1', 'dream'],
];
const hudEl = {};
hud.innerHTML = OPS.map(([fam, name, key]) => `
  <div class="op ${fam}"><div class="op-h"><em>${fam.toUpperCase()}</em>${name}</div>
  <div class="op-b" data-k="${key}">${key === 'spec' ? '<canvas width="96" height="18"></canvas>' :
    key === 'bands' ? '<s><b></b></s><s><b></b></s><s><b></b></s>' : '<s><b></b></s><u></u>'}</div></div>`).join('')
  + '<div class="op-fps"></div>';
hud.querySelectorAll('.op-b').forEach(el => { hudEl[el.dataset.k] = el; });
const specCtx = hudEl.spec.querySelector('canvas').getContext('2d');
const fpsEl = hud.querySelector('.op-fps');
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function meter(key, v, label) {
  const el = hudEl[key];
  const bars = el.querySelectorAll('b');
  if (Array.isArray(v)) v.forEach((x, i) => { bars[i].style.transform = `scaleX(${Math.min(1, x)})`; });
  else bars[0].style.transform = `scaleX(${Math.min(1, Math.max(0, v))})`;
  const u = el.querySelector('u');
  if (u && label !== undefined) u.textContent = label;
}
let hudFrame = 0;
function updateHud(fps, audioV) {
  if (!state.hud || (hudFrame++ & 1)) return;
  meter('lvl', audioV.level, audio.ok ? audioV.level.toFixed(2) : 'off');
  specCtx.clearRect(0, 0, 96, 18);
  specCtx.fillStyle = '#7cf2b0';
  for (let i = 0; i < 48; i++) {
    const v = audio.spec[i * 5] / 255;
    specCtx.fillRect(i * 2, 18 - v * 18, 1.4, v * 18);
  }
  meter('bands', [audioV.bass, audioV.mid, audioV.high]);
  meter('beat', audioV.beat, `#${audio.beatCount}`);
  if (audio.pitch) {
    const m = Math.round(69 + 12 * Math.log2(audio.pitch / 440));
    meter('pitch', audio.pitchConf, `${audio.pitch.toFixed(0)}Hz ${NOTES[(m % 12 + 12) % 12]}${Math.floor(m / 12) - 1}`);
  } else meter('pitch', 0, '—');
  meter('motion', state.motion, state.hasVideo ? state.motion.toFixed(2) : 'off');
  meter('touch', input.pointers.size / 5, `${input.pointers.size} · ${input.tilt.x.toFixed(1)},${input.tilt.y.toFixed(1)}`);
  meter('parts', 1, (PSIZE * PSIZE).toLocaleString());
  const d = state.modeW.reduce((a, w, i) => a + w * DECAY[i], 0);
  meter('fb', d, d.toFixed(3));
  meter('dream', state.dream, state.dream > 0.5 ? 'DREAMING' : 'awake');
  fpsEl.textContent = `${fps.toFixed(0)} fps · ${W}×${H} · ${MODES[state.mode].name}`;
}

// ---------------------------------------------------------------- render helpers
function bindTex(prog, name, tex, unit) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1i(prog.u(name), unit);
}
function target(f) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, f);
  if (f) gl.viewport(0, 0, f.w, f.h); else gl.viewport(0, 0, W, H);
}
const tri = () => gl.drawArrays(gl.TRIANGLES, 0, 3);

function rotMat(yaw, pitch) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  // R = Ry * Rx, column-major
  return new Float32Array([
    cy, 0, -sy,
    sy * sp, cp, cy * sp,
    sy * cp, -sp, cy * cp,
  ]);
}

// ---------------------------------------------------------------- loop
let last = performance.now(), t0 = last, fpsAvg = 60, slowT = 0, frame = 0;
let running = false;

function frameLoop(nowMs) {
  requestAnimationFrame(frameLoop);
  if (!running || document.hidden) { last = nowMs; return; }
  const dt = Math.min(1 / 30, Math.max(1 / 240, (nowMs - last) / 1000));
  last = nowMs;
  const now = nowMs / 1000, t = (nowMs - t0) / 1000;
  fpsAvg += (1 / dt - fpsAvg) * 0.05;
  frame++;

  // 적응형 품질: 느리면 해상도를 낮춘다
  if (fpsAvg < 34 && quality > 0.45) { slowT += dt; if (slowT > 2.5) { quality *= 0.85; makeTargets(); slowT = 0; } }
  else slowT = 0;

  // ---- CHOP: audio
  audio.update(now);
  if (frame % 4 === 0) measureMotion();
  if (audio.level > 0.18) state.lastSound = now;
  if (state.motion > 0.06) state.lastMotion = now;
  const idle = now - Math.max(state.lastSound, state.lastMotion, input.lastActivity / 1000, state.startT || 0);
  state.dream += ((idle > 7 ? 1 : 0) - state.dream) * dt * 0.6;
  const D = state.dream;

  // 꿈꾸는 모드: 아무 자극이 없으면 우주가 스스로 즉흥연주한다
  const vb = Math.pow(0.5 + 0.5 * Math.sin(t * 2.2), 10) * 0.9;
  const vm = 0.35 + 0.3 * Math.sin(t * 0.37);
  const vh = 0.2 + 0.2 * Math.sin(t * 1.3 + 1);
  const A = {
    bass: Math.max(audio.bass, vb * D), mid: Math.max(audio.mid, vm * D),
    high: Math.max(audio.high, vh * D), level: Math.max(audio.level, (0.3 + vb * 0.4) * D),
    beat: Math.max(audio.beat, vb > 0.85 ? D : 0),
  };
  if (D > 0.6) {
    state.dreamModeT += dt;
    if (state.dreamModeT > 18) { state.dreamModeT = 0; setMode(state.mode + 1, true); }
  } else state.dreamModeT = 0;

  // pitch → hue (음이름이 곧 색: 같은 음은 언제나 같은 색)
  let hueT = (t * 0.01) % 1;
  if (audio.pitch > 0) hueT = ((Math.log2(audio.pitch / 55) % 1) + 1) % 1;
  let dh = hueT - state.hue; dh -= Math.round(dh);
  state.hue = (state.hue + dh * (audio.pitch ? 0.12 : 0.01) + 1) % 1;

  for (let i = 0; i < 4; i++) state.modeW[i] += ((i === state.mode ? 1 : 0) - state.modeW[i]) * Math.min(1, dt * 1.8);
  const mw = state.modeW;
  state.burst *= Math.exp(-dt * 6);
  state.flash *= Math.exp(-dt * 3.5);
  state.zoomKick *= Math.exp(-dt * 4);
  input.pinch *= Math.exp(-dt * 0.3);

  if (reso) {
    reso.update({ energy: A.level, motion: state.motion, pitch: audio.pitch, voice: audio.level, bass: A.bass });
    audio.ignoreFreq = reso.harmFreq || 0;
  }

  const aspect = W / H;
  let camScale = [1, 1];
  const va = camW / camH;
  if (aspect > va) camScale = [1, va / aspect]; else camScale = [aspect / va, 1];
  const hasCam = state.hasVideo ? 1 : 0;

  gl.disable(gl.BLEND);

  // ---- TOP: camera
  if (state.hasVideo && video.readyState >= 2) {
    if (video.videoWidth && Math.abs(video.videoWidth / video.videoHeight - camW / camH) > 0.01) {
      const w = 160, h = Math.round(160 * video.videoHeight / video.videoWidth);
      makeCam(w, h);
    }
    gl.bindTexture(gl.TEXTURE_2D, videoTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
  }
  {
    const p = P.cam; gl.useProgram(p);
    target(cam[1 - camI]);
    bindTex(p, 'uVideo', videoTex, 0);
    bindTex(p, 'uPrev', cam[camI].tex[0], 1);
    gl.uniform2f(p.u('uTexel'), 1 / camW, 1 / camH);
    gl.uniform1f(p.u('uMirror'), state.facing === 'user' ? 1 : 0);
    gl.uniform1f(p.u('uHasVideo'), state.hasVideo && video.readyState >= 2 ? 1 : 0);
    tri();
    camI = 1 - camI;
  }
  const camTex = cam[camI].tex[0];

  // spectrum → texture
  gl.bindTexture(gl.TEXTURE_2D, specTex);
  if (audio.ok) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RED, gl.UNSIGNED_BYTE, audio.spec);
  else if (D > 0.01) {
    for (let i = 0; i < 256; i++) audio.spec[i] = 255 * D * (0.3 + 0.3 * Math.sin(i * 0.1 + t * 3) * Math.sin(i * 0.031 - t)) * (1 - i / 300);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RED, gl.UNSIGNED_BYTE, audio.spec);
  }

  // ---- SOP: particles
  {
    const p = P.sim; gl.useProgram(p);
    target(sim[1 - simI]);
    bindTex(p, 'uPos', sim[simI].tex[0], 0);
    bindTex(p, 'uVel', sim[simI].tex[1], 1);
    bindTex(p, 'uCam', camTex, 2);
    bindTex(p, 'uSpec', specTex, 3);
    gl.uniform1f(p.u('uTime'), t);
    gl.uniform1f(p.u('uDt'), dt);
    gl.uniform1f(p.u('uBeat'), A.beat);
    gl.uniform1f(p.u('uBurst'), state.burst);
    gl.uniform1f(p.u('uAspect'), aspect);
    gl.uniform1f(p.u('uHasCam'), hasCam);
    gl.uniform1f(p.u('uK'), K);
    gl.uniform1f(p.u('uPitch'), state.hue);
    gl.uniform4f(p.u('uAudio'), A.bass, A.mid, A.high, A.level);
    gl.uniform4f(p.u('uMode'), mw[0], mw[1], mw[2], mw[3]);
    gl.uniform4fv(p.u('uTouch'), input.touchUniform(aspect, K, performance.now()));
    gl.uniform3f(p.u('uGrav'), input.tilt.x * 0.8, -input.tilt.y * 0.8, 0);
    gl.uniform2f(p.u('uCamScale'), camScale[0], camScale[1]);
    gl.uniform4f(p.u('uAttr'), Math.sin(t * 0.31) * 0.7 * aspect, Math.sin(t * 0.47) * 0.5, D, 0);
    tri();
    simI = 1 - simI;
  }

  // ---- render TOP: points
  {
    const p = P.pts; gl.useProgram(p);
    target(scene);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    bindTex(p, 'uPos', sim[simI].tex[0], 0);
    bindTex(p, 'uVel', sim[simI].tex[1], 1);
    bindTex(p, 'uCam', camTex, 2);
    gl.uniform1i(p.u('uSize'), PSIZE);
    state.autoYaw += dt * (0.04 + 0.12 * (mw[2] + mw[3]) + A.bass * 0.1 * mw[3]);
    const yaw = input.tilt.x * 0.7 + Math.sin(state.autoYaw) * 0.5 * (1 - mw[1]);
    const pitch = input.tilt.y * 0.55 + 0.25 * mw[2];
    gl.uniformMatrix3fv(p.u('uRot'), false, rotMat(yaw, pitch));
    gl.uniform1f(p.u('uAspect'), aspect);
    gl.uniform1f(p.u('uPointScale'), H * 0.0075 * Math.sqrt(65536 / (PSIZE * PSIZE)) * (1 + mw[1] * 0.3) * (isMobile ? 1 : 1.35));
    gl.uniform1f(p.u('uTime'), t);
    gl.uniform1f(p.u('uHue'), state.hue);
    gl.uniform1f(p.u('uHasCam'), hasCam);
    gl.uniform1f(p.u('uK'), K);
    gl.uniform4f(p.u('uAudio'), A.bass, A.mid, A.high, A.level);
    gl.uniform4f(p.u('uMode'), mw[0], mw[1], mw[2], mw[3]);
    gl.uniform2f(p.u('uCamScale'), camScale[0], camScale[1]);
    gl.drawArrays(gl.POINTS, 0, PSIZE * PSIZE);
    gl.disable(gl.BLEND);
  }

  // ---- feedback TOP
  const holes = input.holesUniform(performance.now());
  const decay = mw.reduce((a, w, i) => a + w * DECAY[i], 0);
  {
    const p = P.fb; gl.useProgram(p);
    target(fb[1 - fbI]);
    bindTex(p, 'uScene', scene.tex[0], 0);
    bindTex(p, 'uPrev', fb[fbI].tex[0], 1);
    bindTex(p, 'uCam', camTex, 2);
    gl.uniform1f(p.u('uTime'), t);
    gl.uniform1f(p.u('uDecay'), decay - A.high * 0.02);
    gl.uniform1f(p.u('uInject'), (1 - decay) * TRAIL_GAIN);
    gl.uniform1f(p.u('uZoom'), 1 - 0.002 - A.bass * 0.006 - input.pinch * 0.01 - state.zoomKick);
    gl.uniform1f(p.u('uRotA'), 0.0015 + input.tilt.x * 0.006 * (1 - mw[1]) + mw[2] * 0.003);
    gl.uniform1f(p.u('uFlash'), state.flash);
    gl.uniform1f(p.u('uAspect'), aspect);
    gl.uniform1f(p.u('uHasCam'), hasCam);
    gl.uniform1f(p.u('uHueShift'), 0.004 + A.high * 0.02);
    gl.uniform4f(p.u('uAudio'), A.bass, A.mid, A.high, A.level);
    gl.uniform2f(p.u('uCamScale'), camScale[0], camScale[1]);
    gl.uniform2f(p.u('uRes'), W, H);
    gl.uniform4fv(p.u('uHoles'), holes);
    tri();
    fbI = 1 - fbI;
  }
  const fbTex = fb[fbI].tex[0];

  // ---- bloom
  {
    const p = P.blur; gl.useProgram(p);
    target(bloomA);
    bindTex(p, 'uSrc', fbTex, 0);
    gl.uniform2f(p.u('uTexel'), 1 / W, 1 / H);
    gl.uniform1f(p.u('uThreshold'), 0.9);
    tri();
    target(bloomB);
    bindTex(p, 'uSrc', bloomA.tex[0], 0);
    gl.uniform2f(p.u('uTexel'), 1 / bloomA.w, 1 / bloomA.h);
    gl.uniform1f(p.u('uThreshold'), 0);
    tri();
  }

  // ---- out
  {
    const p = P.fin; gl.useProgram(p);
    target(null);
    bindTex(p, 'uFb', fbTex, 0);
    bindTex(p, 'uBloom', bloomB.tex[0], 1);
    bindTex(p, 'uCam', camTex, 2);
    gl.uniform1f(p.u('uTime'), t);
    gl.uniform1f(p.u('uAberr'), A.high * 0.6 + state.flash * 0.8 + state.burst);
    gl.uniform1f(p.u('uAspect'), aspect);
    gl.uniform1f(p.u('uGhost'), 0.4 + state.motion * 2 + mw[1] * 0.6);
    gl.uniform1f(p.u('uHasCam'), hasCam);
    gl.uniform1f(p.u('uExposure'), mw.reduce((a, w, i) => a + w * EXPOSURE[i], 0) * (1 + state.flash * 0.5));
    gl.uniform2f(p.u('uCamScale'), camScale[0], camScale[1]);
    gl.uniform2f(p.u('uRes'), W, H);
    gl.uniform2f(p.u('uParallax'), input.tilt.x, input.tilt.y);
    gl.uniform4fv(p.u('uHoles'), holes);
    tri();
  }

  if (snapRequested) {
    snapRequested = false;
    canvas.toBlob(b => b && saveBlob(b, `orbita-${Date.now()}.png`), 'image/png');
    $('#flash').classList.remove('go'); void $('#flash').offsetWidth; $('#flash').classList.add('go');
  }

  updateHud(fpsAvg, A);
  window.__orbita = { fps: fpsAvg, A, motion: state.motion, W, H };
  document.body.classList.toggle('dreaming', D > 0.5);
}

// ---------------------------------------------------------------- start
$('#enter').onclick = async () => {
  $('#enter').disabled = true;
  $('#enter').textContent = '연결 중…';
  try {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    await actx.resume();
    reso = new Resonance(actx);
  } catch (e) { console.warn(e); }
  await input.requestSensors();
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) await startMedia(true);
  else status();
  $('#start').classList.add('hidden');
  $('#ui').classList.remove('hidden');
  state.startT = performance.now() / 1000;
  running = true;
  setMode(state.mode);
};

// 시작 화면 뒤에서도 우주는 이미 움직이고 있다
running = true;
state.lastSound = -100;
requestAnimationFrame(frameLoop);
