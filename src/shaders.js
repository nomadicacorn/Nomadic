// ÓRBITA — GLSL operators
// TouchDesigner 식으로 보면: 각 셰이더가 하나의 TOP / SOP 오퍼레이터에 해당한다.
//   camProc  = videodevin → monochrome → cache(prev) → subtract(motion) → edge
//   sim      = GPU particle SOP (force field: noise / pointcloud / gravity / spectrum shell)
//   points   = render TOP (additive point sprites)
//   feedback = feedback TOP + transform + displace + level
//   bloom    = blur TOP chain
//   final    = composite (chroma, stars, edge ghost, tone map, grain)

const H = `#version 300 es
precision highp float;
precision highp int;
`;

export const FULLSCREEN_VS = H + `
out vec2 vUv;
void main(){
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const NOISE = `
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
vec3 hash32(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yxz+33.33); return fract((p3.xxy+p3.yzz)*p3.zyx); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash12(i), hash12(i+vec2(1,0)), u.x), mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), u.x), u.y);
}
`;

// ---------------------------------------------------------------- camProc
// out: r = raw luminance, g = motion (held), b = smoothed luminance (depth), a = edge
export const CAM_FS = H + `
uniform sampler2D uVideo;
uniform sampler2D uPrev;
uniform vec2 uTexel;
uniform float uMirror;
uniform float uHasVideo;
in vec2 vUv;
out vec4 o;
float lum(vec2 uv){ return dot(texture(uVideo, uv).rgb, vec3(.299,.587,.114)); }
void main(){
  vec2 uv = vec2(uMirror > .5 ? 1.0 - vUv.x : vUv.x, 1.0 - vUv.y);
  vec4 prev = texture(uPrev, vUv);
  if (uHasVideo < .5) { o = prev * 0.9; return; }
  float l = lum(uv);
  vec2 t = uTexel;
  float tl = lum(uv+vec2(-t.x, t.y)), tc = lum(uv+vec2(0, t.y)), tr = lum(uv+vec2(t.x, t.y));
  float ml = lum(uv+vec2(-t.x, 0)),                          mr = lum(uv+vec2(t.x, 0));
  float bl = lum(uv+vec2(-t.x,-t.y)), bc = lum(uv+vec2(0,-t.y)), br = lum(uv+vec2(t.x,-t.y));
  float gx = (tr + 2.*mr + br) - (tl + 2.*ml + bl);
  float gy = (tl + 2.*tc + tr) - (bl + 2.*bc + br);
  float edge = smoothstep(0.12, 0.6, length(vec2(gx, gy)));
  float m = abs(l - prev.r);
  m = smoothstep(0.035, 0.25, m);
  m = max(m, prev.g * 0.82);
  float s = mix(prev.b, l, 0.35);
  o = vec4(l, m, s, edge);
}`;

// ---------------------------------------------------------------- particle sim (MRT)
export const SIM_FS = H + `
uniform sampler2D uPos;
uniform sampler2D uVel;
uniform sampler2D uCam;
uniform sampler2D uSpec;
uniform float uTime, uDt, uBeat, uBurst, uAspect, uHasCam, uK, uPitch;
uniform vec4 uAudio;   // bass, mid, high, level
uniform vec4 uMode;    // nebula, mirror, orbit, pulsar
uniform vec4 uTouch[5];// x, y (world), strength(+attract / -repel), active
uniform vec3 uGrav;
uniform vec2 uCamScale;
uniform vec4 uAttr;    // dream attractor xy, strength, unused
layout(location=0) out vec4 oPos;
layout(location=1) out vec4 oVel;
` + NOISE + `
vec3 gradPsi(vec3 p, float t, float s){
  vec3 g = vec3(0); vec3 w;
  w = vec3( 1.7,-1.1, 0.9)*s; g += w*cos(dot(p,w) + t*0.7);
  w = vec3(-0.8, 2.1, 1.3)*s; g += w*cos(dot(p,w) - t*0.5 + 1.3);
  w = vec3( 2.3, 0.6,-1.9)*s; g += w*cos(dot(p,w) + t*0.3 + 2.1)*0.6;
  w = vec3(-3.1,-2.7, 0.4)*s; g += w*cos(dot(p,w) + t*0.9 + 4.2)*0.35;
  return g;
}
// divergence-free-ish flow: cross product of two gradient fields
vec3 flow(vec3 p, float t){
  vec3 q = p + 0.25*sin(p.yzx*2.3 + t*0.2);
  return cross(gradPsi(q, t, 1.0), gradPsi(q.zxy + 3.7, t*1.13, 0.8)) * 0.22;
}
float camLum(vec2 cuv){
  if (uHasCam > .5) return texture(uCam, cuv).b;
  // 카메라가 없을 때: 숨 쉬는 가상의 형상
  vec2 c = (cuv - 0.5) * vec2(1.0, 1.3);
  float r = length(c);
  return smoothstep(0.42, 0.1, r + 0.06*sin(atan(c.y,c.x)*5.0 + uTime) ) * (0.7 + 0.3*vnoise(cuv*6.0 + uTime*0.3));
}
mat2 rot(float a){ float c=cos(a), s=sin(a); return mat2(c,-s,s,c); }
void main(){
  ivec2 ij = ivec2(gl_FragCoord.xy);
  vec2 size = vec2(textureSize(uPos, 0));
  vec2 uv = (vec2(ij) + 0.5) / size;
  vec4 P = texelFetch(uPos, ij, 0);
  vec4 V = texelFetch(uVel, ij, 0);
  vec3 p = P.xyz, v = V.xyz;
  float life = P.w, seed = V.w;
  vec3 rnd = hash32(uv * 917.3 + 0.17);

  float bass = uAudio.x, mid = uAudio.y, high = uAudio.z, lvl = uAudio.w;
  vec3 acc = vec3(0);
  vec3 f = flow(p * (0.9 + 0.35*mid), uTime*(0.22 + 0.5*lvl));

  // 1. NEBULA — 성운: 발산하지 않는 흐름장 + 저음 팽창
  acc += uMode.x * ( f*(1.4 + 4.0*bass) - p*0.12 );

  // 2. MIRROR — 성좌 거울: 카메라 밝기를 깊이로 쓰는 포인트 클라우드
  vec2 home = (uv*2.0 - 1.0) * vec2(uAspect, 1.0) / uK;
  vec2 cuv = (uv - 0.5) * uCamScale + 0.5;
  float L = camLum(cuv);
  float zt = (L - 0.4) * (1.2 + bass*1.4) + sin(home.x*3.0 + uTime*1.5)*0.04*high;
  vec3 target = vec3(home, zt);
  acc += uMode.y * ( (target - p)*7.0 - v*3.0 + f*(0.25 + 2.0*(1.0 - L))*(0.5+mid) );

  // 3. ORBIT — 궤도: 중심 중력 + 접선 소용돌이 (원반)
  {
    vec3 c = vec3(uAttr.xy * uAttr.z, 0.0);
    vec3 d = c - p; float r = length(d) + 0.05;
    vec3 axis = normalize(vec3(0.15 + 0.3*sin(uTime*0.1), 1.0, 0.25));
    vec3 tang = normalize(cross(d, axis) + 1e-5);
    float disk = dot(p - c, axis);
    acc += uMode.z * ( d/(r*r*r + 0.35)*0.9 + tang*(0.9 + 1.5*bass)/(r + 0.25) - axis*disk*1.2 - v*0.12 );
  }

  // 4. PULSAR — 펄서: 스펙트럼으로 숨쉬는 겹겹의 구 껍질
  {
    float th = rnd.y*6.28318, cz = rnd.z*2.0 - 1.0, sz = sqrt(1.0 - cz*cz);
    vec3 sd = vec3(sz*cos(th), sz*sin(th), cz);
    float band = floor(rnd.x*5.0)/5.0;
    float sv = texture(uSpec, vec2(0.02 + band*0.9 + rnd.x*0.08, 0.5)).r;
    float shell = 0.3 + band*0.55 + sv*0.55 + bass*0.25;
    vec3 tp = sd*shell;
    tp.xz = rot(uTime*(0.15 + band*0.25)) * tp.xz;
    tp.yz = rot(uTime*0.07) * tp.yz;
    acc += uMode.w * ( (tp - p)*6.0 - v*2.2 + f*high*1.5 );
  }

  // 카메라 움직임 → 별가루를 흩뿌린다 (모든 모드 공통)
  vec2 suv = vec2(p.x*uK/uAspect, p.y*uK)*0.5 + 0.5;
  float motion = 0.0;
  if (suv.x > 0. && suv.x < 1. && suv.y > 0. && suv.y < 1.) motion = texture(uCam, (suv-0.5)*uCamScale+0.5).g * uHasCam;
  acc += (normalize(rnd - 0.5) * 3.0 + vec3(0,0,2.5) + f*6.0) * motion * (1.0 - uMode.y*0.6);

  // 손가락 = 중력 우물 / 놓으면 화이트홀
  for (int i = 0; i < 5; i++) {
    vec4 T = uTouch[i];
    if (T.w < 0.5) continue;
    vec3 d = vec3(T.xy, 0.0) - p;
    float r2 = dot(d,d) + 0.015;
    float s = T.z;
    acc += d/r2 * 0.45 * s;
    acc += cross(d, vec3(0,0,1)) / (r2 + 0.04) * 0.3 * abs(s);
  }

  // 기울기 = 중력 방향
  acc += uGrav * (0.5 + uMode.x*0.6);

  // 비트 / 흔들기 = 초신성
  vec3 outward = normalize(p + (rnd - 0.5)*0.2 + 1e-4);
  acc += outward * (uBurst*14.0 + uBeat*2.2*(1.0 - uMode.y*0.7));

  v += acc * uDt;
  v *= exp(-uDt*(0.8 + uMode.y*1.2));
  float sp = length(v);
  if (sp > 6.0) v *= 6.0/sp;
  p += v * uDt;

  life -= uDt * (0.04 + 0.12*rnd.z) * (1.0 + motion*3.0);
  if (life <= 0.0 || dot(p,p) > 40.0 || seed == 0.0) {
    vec3 r = hash32(uv*53.1 + fract(uTime*0.1371)*91.7);
    if (uMode.y > 0.5) p = vec3(home + (r.xy-0.5)*0.05, (r.z-0.5)*0.4);
    else p = (r - 0.5) * vec3(2.2*uAspect, 2.2, 1.6);
    v = (r.zxy - 0.5) * 0.2;
    life = 0.6 + 0.4*r.x;
    seed = 0.001 + rnd.x;
  }
  oPos = vec4(p, life);
  oVel = vec4(v, seed);
}`;

// ---------------------------------------------------------------- point render
export const POINTS_VS = H + `
uniform sampler2D uPos;
uniform sampler2D uVel;
uniform sampler2D uCam;
uniform int uSize;
uniform mat3 uRot;
uniform float uAspect, uPointScale, uTime, uHue, uHasCam, uK;
uniform vec4 uAudio;
uniform vec4 uMode;
uniform vec2 uCamScale;
out vec3 vCol;
out float vA;
vec3 palette(float t){
  // 우주 팔레트: 보라 → 마젠타 → 청록 → 심연의 남색 (순환)
  vec3 c0 = vec3(0.42, 0.22, 1.00);
  vec3 c1 = vec3(1.00, 0.30, 0.78);
  vec3 c2 = vec3(0.25, 0.85, 1.00);
  vec3 c3 = vec3(0.20, 0.30, 0.95);
  t = fract(t) * 4.0;
  float f = smoothstep(0.0, 1.0, fract(t));
  if (t < 1.0) return mix(c0, c1, f);
  if (t < 2.0) return mix(c1, c2, f);
  if (t < 3.0) return mix(c2, c3, f);
  return mix(c3, c0, f);
}
void main(){
  ivec2 ij = ivec2(gl_VertexID % uSize, gl_VertexID / uSize);
  vec4 P = texelFetch(uPos, ij, 0);
  vec4 V = texelFetch(uVel, ij, 0);
  vec3 p = uRot * P.xyz;
  float depth = 2.6 - p.z;
  float f = uK * 2.6;
  gl_Position = vec4(p.x*f/(depth*uAspect), p.y*f/depth, 0.0, 1.0);

  float seed = V.w;
  float spd = length(V.xyz);
  vec2 uv = (vec2(ij) + 0.5) / float(uSize);
  float L;
  if (uHasCam > .5) L = texture(uCam, (uv-0.5)*uCamScale+0.5).b;
  else { vec2 c = (uv - 0.5) * vec2(1.0, 1.3); L = smoothstep(0.42, 0.1, length(c) + 0.06*sin(atan(c.y,c.x)*5.0 + uTime)); }
  float vis = mix(1.0, smoothstep(0.08, 0.6, L) + 0.03, uMode.y);

  float t = fract(seed*0.35 + uHue + spd*0.06 + P.z*0.08);
  vec3 col = palette(t);
  col = mix(col, vec3(1.0, 0.95, 0.9), smoothstep(2.5, 6.0, spd)*0.6);
  bool star = seed > 0.992;
  if (star) col = mix(col, vec3(1.0), 0.6);

  float life = P.w;
  float fade = smoothstep(0.0, 0.12, life);
  vA = fade * vis * (0.16 + 0.14*uAudio.w + 0.1*uAudio.z) * (star ? 3.0 : 1.0);
  vCol = col;
  float sz = uPointScale * (0.5 + seed*1.2) * (1.0 + uAudio.x*0.9) / depth;
  if (star) sz *= 2.6;
  gl_PointSize = depth < 0.2 ? 0.0 : clamp(sz, 1.0, 64.0);
}`;

export const POINTS_FS = H + `
in vec3 vCol;
in float vA;
out vec4 o;
void main(){
  vec2 c = gl_PointCoord - 0.5;
  float d2 = dot(c,c);
  float a = exp(-d2*22.0) + exp(-d2*90.0)*0.6;
  o = vec4(vCol * vA * a, 1.0);
}`;

// ---------------------------------------------------------------- feedback
export const FEEDBACK_FS = H + `
uniform sampler2D uScene;
uniform sampler2D uPrev;
uniform sampler2D uCam;
uniform float uTime, uDecay, uZoom, uRotA, uFlash, uAspect, uHasCam, uHueShift, uInject;
uniform vec4 uHoles[5]; // screen uv, strength, active
uniform vec4 uAudio;
uniform vec2 uCamScale, uRes;
in vec2 vUv;
out vec4 o;
` + NOISE + `
vec3 hueRot(vec3 c, float a){
  const vec3 k = vec3(0.57735);
  float ca = cos(a);
  return c*ca + cross(k, c)*sin(a) + k*dot(k, c)*(1.0 - ca);
}
void main(){
  vec2 uv = vUv;
  vec2 c = uv - 0.5; c.x *= uAspect;
  float a = uRotA;
  c = mat2(cos(a), -sin(a), sin(a), cos(a)) * c;
  c *= uZoom;
  vec4 cam = texture(uCam, (uv-0.5)*uCamScale + 0.5);
  // displace TOP: 흐르는 노이즈 + 몸의 움직임이 시공간을 휘게 한다
  vec2 n = vec2(vnoise(c*3.0 + uTime*0.15), vnoise(c*3.0 - uTime*0.13 + 7.1)) - 0.5;
  c += n * 0.006 * (0.4 + uAudio.y*2.5);
  c += normalize(c + 1e-4) * cam.g * 0.004 * uHasCam;
  // 중력 렌즈: 손끝의 블랙홀이 빛(지난 프레임)을 빨아들이고, 화이트홀은 밀어낸다
  for (int i = 0; i < 5; i++) {
    vec4 h = uHoles[i];
    if (h.w < 0.5) continue;
    vec2 hp = (h.xy - 0.5) * vec2(uAspect, 1.0);
    vec2 d = c - hp;
    float r = length(d) + 1e-4;
    vec2 tang = vec2(-d.y, d.x) / r;
    c += (d / r) * h.z * 0.0045 / (r + 0.06) + tang * abs(h.z) * 0.002 / (r + 0.1);
  }
  c.x /= uAspect;
  vec3 prev = texture(uPrev, c + 0.5).rgb;
  prev = hueRot(prev, uHueShift) * uDecay;
  prev = min(prev, vec3(6.0));
  vec3 scene = texture(uScene, uv).rgb;
  // 별자리 각인: 큰 소리가 나면 당신의 윤곽이 별가루로 남아 흩어진다
  float sparkle = step(0.86, hash12(floor(uv*uRes*0.34) + floor(uTime*12.0)));
  vec3 imprint = vec3(0.55, 0.75, 1.0) * cam.a * sparkle * smoothstep(0.35, 1.0, uFlash) * 1.2 * uHasCam;
  o = vec4(prev + scene*uInject + imprint, 1.0);
}`;

// ---------------------------------------------------------------- bloom (blur chain)
export const BLUR_FS = H + `
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uThreshold;
in vec2 vUv;
out vec4 o;
void main(){
  vec3 s = vec3(0);
  float w = 0.0;
  for (int y = -2; y <= 2; y++) for (int x = -2; x <= 2; x++) {
    vec2 off = vec2(x, y);
    float k = exp(-dot(off,off)*0.35);
    vec3 c = texture(uSrc, vUv + off*uTexel*1.5).rgb;
    c = max(c - uThreshold, 0.0);
    s += c*k; w += k;
  }
  o = vec4(s/w, 1.0);
}`;

// ---------------------------------------------------------------- final composite
export const FINAL_FS = H + `
uniform sampler2D uFb;
uniform sampler2D uBloom;
uniform sampler2D uCam;
uniform float uTime, uAberr, uAspect, uGhost, uHasCam, uExposure;
uniform vec2 uCamScale, uRes, uParallax;
uniform vec4 uHoles[5];
in vec2 vUv;
out vec4 o;
` + NOISE + `
vec3 stars(vec2 uv){
  vec3 s = vec3(0);
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float sc = 40.0 + fi*55.0;
    vec2 g = (uv + uParallax*(0.01 + fi*0.012)) * vec2(uAspect, 1.0) * sc;
    vec2 id = floor(g), f = fract(g) - 0.5;
    float h = hash12(id + fi*17.3);
    if (h > 0.955) {
      vec2 off = (hash22(id) - 0.5)*0.7;
      float d = length(f - off);
      float tw = 0.55 + 0.45*sin(uTime*(1.5 + h*6.0) + h*60.0);
      vec3 tint = mix(vec3(0.7,0.8,1.0), vec3(1.0,0.85,0.75), hash12(id*1.7));
      s += tint * smoothstep(0.09 - fi*0.02, 0.0, d) * tw * (h - 0.955) * 22.0 / (1.0 + fi);
    }
  }
  return s;
}
void main(){
  vec2 uv = vUv;
  vec2 c = uv - 0.5;
  float ab = 0.0012 + uAberr*0.009;
  vec3 col;
  col.r = texture(uFb, uv + c*ab).r;
  col.g = texture(uFb, uv).g;
  col.b = texture(uFb, uv - c*ab).b;
  col += texture(uBloom, uv).rgb * 0.7;

  // 심우주 배경: 희미한 성운 + 별
  vec2 q = uv*vec2(uAspect,1.0)*1.6 + uParallax*0.05;
  float neb = vnoise(q*1.3 + uTime*0.01)*0.6 + vnoise(q*3.1 - uTime*0.015)*0.3 + vnoise(q*7.0)*0.1;
  neb = pow(neb, 3.0);
  col += vec3(0.08, 0.03, 0.16)*neb + vec3(0.0, 0.03, 0.06)*neb*neb;
  col += stars(uv);

  // 카메라 윤곽의 유령 (edge TOP)
  vec4 cam = texture(uCam, (uv-0.5)*uCamScale + 0.5);
  col += vec3(0.3, 0.55, 1.0) * cam.a * uGhost * 0.08 * uHasCam;

  // 사건의 지평선 + 광자 고리
  for (int i = 0; i < 5; i++) {
    vec4 h = uHoles[i];
    if (h.w < 0.5 || h.z <= 0.0) continue;
    float r = length((uv - h.xy) * vec2(uAspect, 1.0));
    float rh = 0.012 * h.z;
    col *= smoothstep(rh * 0.85, rh * 1.25, r);
    col += vec3(1.0, 0.8, 0.95) * exp(-pow((r - rh * 1.35) / (rh * 0.25 + 0.002), 2.0)) * 0.5;
  }
  col *= uExposure;
  col = 1.0 - exp(-col*1.25);
  float vig = smoothstep(1.15, 0.25, length(c*vec2(uAspect*0.8, 1.0)));
  col *= mix(0.55, 1.0, vig);
  col += (hash12(uv*uRes + fract(uTime)*100.0) - 0.5) * 0.035;
  o = vec4(pow(max(col, 0.0), vec3(0.92)), 1.0);
}`;
