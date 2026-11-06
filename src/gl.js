export function createProgram(gl, vsSrc, fsSrc) {
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      console.error(log, src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n'));
      throw new Error('shader compile: ' + log);
    }
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
  const locs = new Map();
  p.u = name => {
    if (!locs.has(name)) locs.set(name, gl.getUniformLocation(p, name));
    return locs.get(name);
  };
  return p;
}

export function createTexture(gl, w, h, { internal, format, type, filter = gl.LINEAR, data = null }) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  t.w = w; t.h = h;
  return t;
}

export function createFBO(gl, textures) {
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  const att = textures.map((t, i) => {
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0);
    return gl.COLOR_ATTACHMENT0 + i;
  });
  gl.drawBuffers(att);
  const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  fb.ok = st === gl.FRAMEBUFFER_COMPLETE;
  fb.w = textures[0].w; fb.h = textures[0].h;
  fb.tex = textures;
  return fb;
}

export function deleteFBO(gl, fb) {
  if (!fb) return;
  fb.tex.forEach(t => gl.deleteTexture(t));
  gl.deleteFramebuffer(fb);
}
