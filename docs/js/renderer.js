import { Mat4, Frustum, subpixelJitterNdc } from './math3d.js';
import { UpAxis } from './camera.js';
import { MATCAP_SIZE, MatcapKind, generateMatcapRgba8 } from './matcap.js';
import { cullChunks } from './culling.js';

const FULLSCREEN_VS = `#version 300 es
precision highp float;
out vec2 vUV;
void main() {
  const vec2 pos[3] = vec2[](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  gl_Position = vec4(pos[gl_VertexID], 0.0, 1.0);
  vUV = pos[gl_VertexID] * 0.5 + 0.5;
}
`;

const BG_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform int uDark;
out vec4 FragColor;
void main() {
  float t = clamp(vUV.y, 0.0, 1.0);
  vec2 d = vUV - vec2(0.5);
  float vig = dot(d, d) * 0.35;
  vec3 col;
  if (uDark != 0) {
    vec3 bot = vec3(0.011, 0.014, 0.019);
    vec3 top = vec3(0.027, 0.033, 0.045);
    col = mix(bot, top, smoothstep(0.0, 1.0, t)) * (1.0 - vig * 0.45);
  } else {
    vec3 bot = vec3(0.58, 0.62, 0.68);
    vec3 top = vec3(0.84, 0.87, 0.91);
    col = mix(bot, top, smoothstep(0.0, 1.0, t)) * (1.0 - vig * 0.12);
  }
  FragColor = vec4(col, 1.0);
}
`;

const MESH_VS = `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec4 aPos;

uniform mat4 uView;
uniform mat4 uProj;
uniform vec3 uBboxMin;
uniform vec3 uQuantScale;
uniform vec4 uClipPlane;
uniform int uClipOn;

out vec3 vViewPos;
out vec3 vWorldPos;
out vec3 vBary;
out float vClipDist;

void main() {
  vec3 worldPos = uBboxMin + aPos.xyz * uQuantScale;
  vWorldPos = worldPos;
  vec4 vp = uView * vec4(worldPos, 1.0);
  vViewPos = vp.xyz;
  vClipDist = (uClipOn != 0) ? dot(vec4(worldPos, 1.0), uClipPlane) : 1.0;
  int vid = gl_VertexID % 3;
  vBary = vec3(vid == 0 ? 1.0 : 0.0, vid == 1 ? 1.0 : 0.0, vid == 2 ? 1.0 : 0.0);
  gl_Position = uProj * vp;
}
`;

const MESH_FS = `#version 300 es
precision highp float;
precision highp int;
in vec3 vViewPos;
in vec3 vWorldPos;
in vec3 vBary;
in float vClipDist;

uniform sampler2D uMatcap;
uniform int uClipOn;
uniform int uXray;
uniform int uWire;
uniform int uDark;
uniform int uOverhang;
uniform int uYUp;

out vec4 FragColor;

void main() {
  if (uClipOn != 0 && vClipDist < 0.0) discard;

  vec3 dpdx = dFdx(vViewPos);
  vec3 dpdy = dFdy(vViewPos);
  vec3 crossN = cross(dpdx, dpdy);
  float len2 = dot(crossN, crossN);
  vec3 N = (len2 > 1e-20) ? (crossN * inversesqrt(len2)) : vec3(0.0, 0.0, 1.0);

  bool backFace = !gl_FrontFacing;
  if (backFace) N = -N;
  if (N.z < 0.0) {
    N.z = 0.0;
    float xy2 = dot(N.xy, N.xy);
    if (xy2 > 1e-8) N.xy *= inversesqrt(xy2);
  }

  vec3 col;
  float alpha = 1.0;

  if (uXray != 0) {
    float rim = pow(clamp(1.0 - abs(N.z), 0.0, 1.0), 1.85);
    vec3 base = (uDark != 0) ? vec3(0.16, 0.56, 0.96) : vec3(0.04, 0.24, 0.54);
    col = base * (0.28 + 1.35 * rim);
    alpha = clamp(0.14 + 0.72 * rim, 0.14, 0.88);
  } else {
    vec2 uv = vec2(N.x * 0.492 + 0.5, 0.5 - N.y * 0.492);
    col = texture(uMatcap, uv).rgb;
    if (backFace) {
      vec3 backTint = vec3(0.55, 0.22, 0.14);
      col = mix(col * 0.75, backTint * (0.45 + 0.65 * clamp(N.z, 0.0, 1.0)), 0.68);
    } else if (uOverhang != 0) {
      vec3 wn = cross(dFdx(vWorldPos), dFdy(vWorldPos));
      float wl2 = dot(wn, wn);
      if (wl2 > 1e-20) {
        wn *= inversesqrt(wl2);
        float upDot = (uYUp != 0) ? wn.y : wn.z;
        if (upDot < -0.70710678) {
          vec3 coral = vec3(0.92, 0.14, 0.08) * (0.35 + 0.65 * clamp(N.z, 0.0, 1.0));
          col = mix(col * 0.30, coral, 0.82);
        }
      }
    }
  }

  if (uWire != 0) {
    vec3 fw = max(fwidth(vBary), vec3(1e-5));
    vec3 f = smoothstep(vec3(0.0), fw * 1.35, vBary);
    float edge = 1.0 - min(min(f.x, f.y), f.z);
    vec3 wc = (uDark != 0) ? vec3(0.24, 0.58, 0.96) : vec3(0.05, 0.18, 0.40);
    col = mix(col, wc, edge * 0.78);
    alpha = max(alpha, edge * 0.85);
  }

  FragColor = vec4(col, alpha);
}
`;

const PICK_VS = `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec4 aPos;

uniform mat4 uPickVP;
uniform vec3 uBboxMin;
uniform vec3 uQuantScale;
uniform vec4 uClipPlane;
uniform int uClipOn;

out float vClipDist;

void main() {
  vec3 worldPos = uBboxMin + aPos.xyz * uQuantScale;
  vClipDist = (uClipOn != 0) ? dot(vec4(worldPos, 1.0), uClipPlane) : 1.0;
  gl_Position = uPickVP * vec4(worldPos, 1.0);
}
`;

const PICK_FS = `#version 300 es
precision highp float;
precision highp int;
in float vClipDist;
uniform int uClipOn;
out vec4 FragColor;

void main() {
  if (uClipOn != 0 && vClipDist < 0.0) discard;
  float z = clamp(gl_FragCoord.z, 0.0, 1.0);
  uint zi = uint(z * 16777215.0 + 0.5);
  float r = float((zi >> 16u) & 255u) / 255.0;
  float g = float((zi >> 8u) & 255u) / 255.0;
  float b = float(zi & 255u) / 255.0;
  FragColor = vec4(r, g, b, 1.0);
}
`;

const GRID_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
uniform mat4 uVP;
out vec3 vWorld;
void main() {
  vWorld = aPos;
  gl_Position = uVP * vec4(aPos, 1.0);
}
`;

const GRID_FS = `#version 300 es
precision highp float;
precision highp int;
in vec3 vWorld;

uniform vec3 uCenter;
uniform float uStep;
uniform float uRadius;
uniform int uYUp;
uniform int uDark;

out vec4 FragColor;

float gridLine(vec2 coord, float spacing) {
  vec2 p = coord / spacing;
  vec2 g = abs(fract(p - 0.5) - 0.5) / max(fwidth(p), vec2(1e-5));
  float d = min(g.x, g.y);
  return 1.0 - min(d, 1.0);
}

void main() {
  vec2 plane = (uYUp != 0) ? vWorld.xz : vWorld.xy;
  vec2 center2 = (uYUp != 0) ? uCenter.xz : uCenter.xy;

  float dist = length(plane - center2);
  float fade = exp(-(dist * dist) / max(uRadius * uRadius * 0.42, 1e-4));
  if (fade < 0.005) discard;

  float minor = gridLine(plane, uStep);
  float major = gridLine(plane, uStep * 10.0);

  vec2 fw = max(fwidth(plane), vec2(1e-5));
  float ax0 = 1.0 - min(abs(plane.y) / (fw.y * 1.4), 1.0);
  float ax1 = 1.0 - min(abs(plane.x) / (fw.x * 1.4), 1.0);

  vec3 minorCol = (uDark != 0) ? vec3(0.18, 0.21, 0.27) : vec3(0.32, 0.36, 0.42);
  vec3 majorCol = (uDark != 0) ? vec3(0.28, 0.33, 0.42) : vec3(0.20, 0.24, 0.30);
  vec3 xCol     = (uDark != 0) ? vec3(0.75, 0.24, 0.24) : vec3(0.72, 0.16, 0.16);
  vec3 yCol     = (uDark != 0) ? vec3(0.24, 0.68, 0.32) : vec3(0.14, 0.52, 0.20);
  if (uYUp != 0) {
    yCol = (uDark != 0) ? vec3(0.26, 0.48, 0.82) : vec3(0.14, 0.34, 0.72);
  }

  float a = max(minor * 0.22, major * 0.48);
  vec3 col = mix(minorCol, majorCol, smoothstep(0.1, 0.9, major));
  if (ax0 > 0.01) {
    col = mix(col, xCol, ax0 * 0.8);
    a = max(a, ax0 * 0.65);
  }
  if (ax1 > 0.01) {
    col = mix(col, yCol, ax1 * 0.8);
    a = max(a, ax1 * 0.65);
  }

  a *= fade;
  if (a < 0.004) discard;
  FragColor = vec4(col, a);
}
`;

const LINE_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec4 aCol;
uniform mat4 uVP;
out vec4 vCol;
void main() {
  gl_Position = uVP * vec4(aPos, 1.0);
  vCol = aCol;
}
`;

const LINE_FS = `#version 300 es
precision highp float;
in vec4 vCol;
out vec4 FragColor;
void main() {
  FragColor = vCol;
}
`;

const ACCUM_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform float uWeight;
out vec4 FragColor;
void main() {
  vec3 c = texture(uTex, vUV).rgb;
  FragColor = vec4(c, uWeight);
}
`;

const RESOLVE_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
out vec4 FragColor;

vec3 linearToSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(hi, lo, lessThanEqual(c, vec3(0.0031308)));
}

void main() {
  vec3 c = texture(uTex, vUV).rgb;
  vec3 s = linearToSrgb(c);
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  s += (n - 0.5) / 255.0;
  FragColor = vec4(clamp(s, 0.0, 1.0), 1.0);
}
`;

function compileProgram(gl, vsSrc, fsSrc, tag) {
  const comp = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error(`${tag} shader compile error: ${log}`);
    }
    return s;
  };
  const vs = comp(gl.VERTEX_SHADER, vsSrc);
  const fs = comp(gl.FRAGMENT_SHADER, fsSrc);
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error(`${tag} program link error: ${log}`);
  }
  return p;
}

function appendDiamond3d(out, p, r, col) {
  const px = [p.x + r, p.y, p.z], nx = [p.x - r, p.y, p.z];
  const py = [p.x, p.y + r, p.z], ny = [p.x, p.y - r, p.z];
  const pz = [p.x, p.y, p.z + r], nz = [p.x, p.y, p.z - r];
  const seg = (a, b) => {
    out.push(a[0], a[1], a[2], col[0], col[1], col[2], col[3]);
    out.push(b[0], b[1], b[2], col[0], col[1], col[2], col[3]);
  };
  seg(px, py); seg(py, nx); seg(nx, ny); seg(ny, px);
  seg(px, pz); seg(pz, nx); seg(nx, nz); seg(nz, px);
  seg(py, pz); seg(pz, ny); seg(ny, nz); seg(nz, py);
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.backend = 'WebGL2';
    this.needsCpuVertices = false;
    this.gl = null;
    this.width = 1;
    this.height = 1;
    this.dpr = 1;
    this.fp16Fbo = false;
    this.accumCount = 0;
    this.targetSamples = 16;
    this.hasMesh = false;
    this.glInfo = '';
    this.lastCstats = {
      totalChunks: 0,
      frustumCulled: 0,
      coneCulled: 0,
      visibleChunks: 0,
      visibleTris: 0,
      drawCalls: 0,
    };

    this.sceneFbo = null;
    this.sceneColor = null;
    this.sceneDepthRb = null;
    this.accumFbo = null;
    this.accumColor = null;
    this.pickFbo = null;
    this.pickColor = null;
    this.pickDepthRb = null;

    this.emptyVao = null;
    this.meshVao = null;
    this.meshVbo = null;
    this.lineVao = null;
    this.lineVbo = null;
    this.matcapTex = [];
    this.lineScratch = new Float32Array(256);
    this.gridScratch = new Float32Array(42);
    this.triadScratch = new Float32Array(42);
    this.pickPixel = new Uint8Array(4);
  }

  init(width, height, dpr) {
    let gl = this.canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      powerPreference: 'low-power',
      preserveDrawingBuffer: false,
    });
    if (!gl) {
      gl = this.canvas.getContext('webgl2');
    }
    if (!gl) {
      throw new Error('WebGL2 is not supported by this browser/GPU.');
    }
    this.gl = gl;
    this.width = Math.max(1, width | 0);
    this.height = Math.max(1, height | 0);
    this.dpr = dpr || 1;

    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    this.glInfo = dbg
      ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);

    this.extFloat = gl.getExtension('EXT_color_buffer_float');
    this.extHalf = gl.getExtension('EXT_color_buffer_half_float');

    this.bgProg = compileProgram(gl, FULLSCREEN_VS, BG_FS, 'bg');
    this.uBgDark = gl.getUniformLocation(this.bgProg, 'uDark');

    this.meshProg = compileProgram(gl, MESH_VS, MESH_FS, 'mesh');
    this.uMeshView = gl.getUniformLocation(this.meshProg, 'uView');
    this.uMeshProj = gl.getUniformLocation(this.meshProg, 'uProj');
    this.uMeshBmin = gl.getUniformLocation(this.meshProg, 'uBboxMin');
    this.uMeshQscale = gl.getUniformLocation(this.meshProg, 'uQuantScale');
    this.uMeshClipPlane = gl.getUniformLocation(this.meshProg, 'uClipPlane');
    this.uMeshClipOn = gl.getUniformLocation(this.meshProg, 'uClipOn');
    this.uMeshMatcap = gl.getUniformLocation(this.meshProg, 'uMatcap');
    this.uMeshXray = gl.getUniformLocation(this.meshProg, 'uXray');
    this.uMeshWire = gl.getUniformLocation(this.meshProg, 'uWire');
    this.uMeshDark = gl.getUniformLocation(this.meshProg, 'uDark');
    this.uMeshOverhang = gl.getUniformLocation(this.meshProg, 'uOverhang');
    this.uMeshYUp = gl.getUniformLocation(this.meshProg, 'uYUp');

    this.pickProg = compileProgram(gl, PICK_VS, PICK_FS, 'pick');
    this.uPickVP = gl.getUniformLocation(this.pickProg, 'uPickVP');
    this.uPickBmin = gl.getUniformLocation(this.pickProg, 'uBboxMin');
    this.uPickQscale = gl.getUniformLocation(this.pickProg, 'uQuantScale');
    this.uPickClipPlane = gl.getUniformLocation(this.pickProg, 'uClipPlane');
    this.uPickClipOn = gl.getUniformLocation(this.pickProg, 'uClipOn');

    this.gridProg = compileProgram(gl, GRID_VS, GRID_FS, 'grid');
    this.uGridVP = gl.getUniformLocation(this.gridProg, 'uVP');
    this.uGridCenter = gl.getUniformLocation(this.gridProg, 'uCenter');
    this.uGridStep = gl.getUniformLocation(this.gridProg, 'uStep');
    this.uGridRadius = gl.getUniformLocation(this.gridProg, 'uRadius');
    this.uGridYup = gl.getUniformLocation(this.gridProg, 'uYUp');
    this.uGridDark = gl.getUniformLocation(this.gridProg, 'uDark');

    this.lineProg = compileProgram(gl, LINE_VS, LINE_FS, 'line');
    this.uLineVP = gl.getUniformLocation(this.lineProg, 'uVP');

    this.accumProg = compileProgram(gl, FULLSCREEN_VS, ACCUM_FS, 'accum');
    this.uAccumTex = gl.getUniformLocation(this.accumProg, 'uTex');
    this.uAccumWeight = gl.getUniformLocation(this.accumProg, 'uWeight');

    this.resolveProg = compileProgram(gl, FULLSCREEN_VS, RESOLVE_FS, 'resolve');
    this.uResolveTex = gl.getUniformLocation(this.resolveProg, 'uTex');

    this.emptyVao = gl.createVertexArray();

    this.meshVao = gl.createVertexArray();
    this.meshVbo = gl.createBuffer();
    gl.bindVertexArray(this.meshVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshVbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.UNSIGNED_SHORT, true, 8, 0);

    this.lineVao = gl.createVertexArray();
    this.lineVbo = gl.createBuffer();
    gl.bindVertexArray(this.lineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 12);
    gl.bindVertexArray(null);

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    for (let i = 0; i < MatcapKind.Count; i++) {
      const tex = gl.createTexture();
      const pixels = generateMatcapRgba8(i);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      while (gl.getError() !== gl.NO_ERROR) {}
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, MATCAP_SIZE, MATCAP_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      if (gl.getError() === gl.NO_ERROR) {
        gl.generateMipmap(gl.TEXTURE_2D);
        if (gl.getError() === gl.NO_ERROR) {
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        } else {
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        }
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, MATCAP_SIZE, MATCAP_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      }
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.matcapTex.push(tex);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);

    this._createFbos(this.width, this.height);
    this.accumCount = 0;
  }

  _destroyFbos() {
    const gl = this.gl;
    if (!gl) return;
    if (this.sceneFbo) gl.deleteFramebuffer(this.sceneFbo);
    if (this.accumFbo) gl.deleteFramebuffer(this.accumFbo);
    if (this.sceneColor) gl.deleteTexture(this.sceneColor);
    if (this.accumColor) gl.deleteTexture(this.accumColor);
    if (this.sceneDepthRb) gl.deleteRenderbuffer(this.sceneDepthRb);
    this.sceneFbo = this.accumFbo = this.sceneColor = this.accumColor = this.sceneDepthRb = null;
  }

  _createFbos(w, h) {
    const gl = this.gl;
    this._destroyFbos();

    const tryBuild = (internalFmt, type, depthFmt) => {
      this.sceneColor = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.sceneColor);
      gl.texImage2D(gl.TEXTURE_2D, 0, internalFmt, w, h, 0, gl.RGBA, type, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      this.sceneDepthRb = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.sceneDepthRb);
      gl.renderbufferStorage(gl.RENDERBUFFER, depthFmt, w, h);

      this.sceneFbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.sceneColor, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.sceneDepthRb);
      const ok1 = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;

      this.accumColor = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.accumColor);
      gl.texImage2D(gl.TEXTURE_2D, 0, internalFmt, w, h, 0, gl.RGBA, type, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      this.accumFbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.accumFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.accumColor, 0);
      const ok2 = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.bindRenderbuffer(gl.RENDERBUFFER, null);
      return ok1 && ok2;
    };

    if ((this.extFloat || this.extHalf) && tryBuild(gl.RGBA16F, gl.HALF_FLOAT, gl.DEPTH_COMPONENT24)) {
      this.fp16Fbo = true;
      return;
    }
    this._destroyFbos();
    if (tryBuild(gl.RGBA8, gl.UNSIGNED_BYTE, gl.DEPTH_COMPONENT24)) {
      this.fp16Fbo = false;
      return;
    }
    this._destroyFbos();
    if (tryBuild(gl.RGBA8, gl.UNSIGNED_BYTE, gl.DEPTH_COMPONENT16)) {
      this.fp16Fbo = false;
      return;
    }
    this._destroyFbos();
    throw new Error('Failed to create WebGL2 scene/accumulation framebuffers.');
  }

  _ensurePickFbo() {
    if (this.pickFbo) return;
    const gl = this.gl;
    this.pickColor = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.pickColor);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    this.pickDepthRb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.pickDepthRb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, 1, 1);

    this.pickFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.pickColor, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.pickDepthRb);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
  }

  resize(width, height, dpr) {
    const w = Math.max(1, width | 0);
    const h = Math.max(1, height | 0);
    this.dpr = dpr || 1;
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this._createFbos(w, h);
    this.accumCount = 0;
  }

  setTargetSamples(n) {
    this.targetSamples = Math.max(1, n | 0);
    if (this.accumCount > this.targetSamples) {
      this.accumCount = this.targetSamples;
    }
  }

  resetAccumulation() {
    this.accumCount = 0;
  }

  needsMoreSamples() {
    return this.accumCount < this.targetSamples;
  }

  uploadMesh(mesh) {
    const gl = this.gl;
    if (!mesh || !mesh.ok || !mesh.vertices || mesh.vertices.length === 0) {
      this.hasMesh = false;
      return;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshVbo);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.hasMesh = true;
    this.accumCount = 0;
  }

  _computeClipPlane(mesh, state) {
    const plane = [0, 0, 0, 1];
    if (state.sliceEnabled && mesh && mesh.ok) {
      const axis = state.sliceAxis;
      const bmin = axis === 0 ? mesh.bboxMin.x : axis === 1 ? mesh.bboxMin.y : mesh.bboxMin.z;
      const bext = axis === 0 ? mesh.bboxExtent.x : axis === 1 ? mesh.bboxExtent.y : mesh.bboxExtent.z;
      const pos = bmin + state.sliceT * bext;
      const sign = state.sliceFlip ? 1.0 : -1.0;
      plane[axis] = sign;
      plane[3] = -sign * pos;
    }
    return plane;
  }

  renderFrame(mesh, cam, state) {
    const gl = this.gl;
    let cstats = this.lastCstats;

    if (this.accumCount < this.targetSamples) {
      cstats = {
        totalChunks: 0,
        frustumCulled: 0,
        coneCulled: 0,
        visibleChunks: 0,
        visibleTris: 0,
        drawCalls: 0,
      };
      const sampleIdx = this.accumCount;
      const { jx, jy } = subpixelJitterNdc(sampleIdx, this.width, this.height);

      const view = cam.viewMatrix();
      const proj = cam.projMatrix(this.width, this.height, jx, jy);
      const vp = Mat4.multiply(proj, view);

      // 1. Render scene into sceneFbo
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
      gl.viewport(0, 0, this.width, this.height);

      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.BLEND);

      gl.useProgram(this.bgProg);
      gl.uniform1i(this.uBgDark, state.darkTheme ? 1 : 0);
      gl.bindVertexArray(this.emptyVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      gl.depthMask(true);
      gl.clearDepth(1.0);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);

      const modelValid = this.hasMesh && mesh && mesh.ok;
      if (modelValid) {
        const useCull = !state.twoSided && !state.sliceEnabled && !state.xray;
        if (useCull) {
          gl.enable(gl.CULL_FACE);
          gl.cullFace(gl.BACK);
          gl.frontFace(gl.CCW);
        } else {
          gl.disable(gl.CULL_FACE);
        }

        const fr = Frustum.fromViewProj(cam.viewProj(this.width, this.height));
        const { spans, stats } = cullChunks(mesh.chunks, fr, {
          backfaceConeCull: useCull,
          isOrtho: cam.isOrtho(),
          eye: cam.eye(),
          camForward: cam.forward(),
        });
        cstats = stats;

        const clipPlane = this._computeClipPlane(mesh, state);

        gl.useProgram(this.meshProg);
        gl.uniformMatrix4fv(this.uMeshView, false, view);
        gl.uniformMatrix4fv(this.uMeshProj, false, proj);
        gl.uniform3f(this.uMeshBmin, mesh.bboxMin.x, mesh.bboxMin.y, mesh.bboxMin.z);
        gl.uniform3f(this.uMeshQscale, mesh.quantScale.x, mesh.quantScale.y, mesh.quantScale.z);
        gl.uniform4f(this.uMeshClipPlane, clipPlane[0], clipPlane[1], clipPlane[2], clipPlane[3]);
        gl.uniform1i(this.uMeshClipOn, state.sliceEnabled ? 1 : 0);
        gl.uniform1i(this.uMeshDark, state.darkTheme ? 1 : 0);
        gl.uniform1i(this.uMeshWire, state.wireframe ? 1 : 0);
        gl.uniform1i(this.uMeshOverhang, state.overhang ? 1 : 0);
        gl.uniform1i(this.uMeshYUp, cam.getUpAxis() === UpAxis.YUp ? 1 : 0);

        const mc = Math.max(0, Math.min(MatcapKind.Count - 1, state.matcap | 0));
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.matcapTex[mc]);
        gl.uniform1i(this.uMeshMatcap, 0);

        gl.bindVertexArray(this.meshVao);

        if (state.xray) {
          gl.depthMask(false);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          gl.uniform1i(this.uMeshXray, 1);
          for (let i = 0; i < spans.length; i++) {
            gl.drawArrays(gl.TRIANGLES, spans[i].firstVert, spans[i].vertCount);
          }
          gl.disable(gl.BLEND);
          gl.depthMask(true);
        } else {
          gl.uniform1i(this.uMeshXray, 0);
          for (let i = 0; i < spans.length; i++) {
            gl.drawArrays(gl.TRIANGLES, spans[i].firstVert, spans[i].vertCount);
          }
        }
      }

      // Ground Grid
      if (state.showGrid) {
        const gc = modelValid
          ? {
              x: (mesh.bboxMin.x + mesh.bboxMax.x) * 0.5,
              y: (mesh.bboxMin.y + mesh.bboxMax.y) * 0.5,
              z: (mesh.bboxMin.z + mesh.bboxMax.z) * 0.5,
            }
          : { x: 0, y: 0, z: 0 };
        const mr = modelValid
          ? Math.max(Math.hypot(mesh.bboxExtent.x, mesh.bboxExtent.y, mesh.bboxExtent.z) * 0.5, 1.0)
          : 50.0;
        const gSpan = Math.max(mr * 10.0, cam.distance() * 6.0);
        const logS = Math.floor(Math.log10(Math.max(mr * 0.45, 0.05)));
        const step = Math.pow(10.0, logS);
        const q = this.gridScratch;

        if (cam.getUpAxis() === UpAxis.ZUp) {
          const gz = modelValid ? mesh.bboxMin.z - mr * 0.001 : 0.0;
          const x0 = gc.x - gSpan, x1 = gc.x + gSpan;
          const y0 = gc.y - gSpan, y1 = gc.y + gSpan;
          q.set([
            x0, y0, gz, 0, 0, 0, 0,
            x1, y0, gz, 0, 0, 0, 0,
            x1, y1, gz, 0, 0, 0, 0,
            x0, y0, gz, 0, 0, 0, 0,
            x1, y1, gz, 0, 0, 0, 0,
            x0, y1, gz, 0, 0, 0, 0,
          ]);
        } else {
          const gy = modelValid ? mesh.bboxMin.y - mr * 0.001 : 0.0;
          const x0 = gc.x - gSpan, x1 = gc.x + gSpan;
          const z0 = gc.z - gSpan, z1 = gc.z + gSpan;
          q.set([
            x0, gy, z0, 0, 0, 0, 0,
            x1, gy, z0, 0, 0, 0, 0,
            x1, gy, z1, 0, 0, 0, 0,
            x0, gy, z0, 0, 0, 0, 0,
            x1, gy, z1, 0, 0, 0, 0,
            x0, gy, z1, 0, 0, 0, 0,
          ]);
        }

        gl.disable(gl.CULL_FACE);
        gl.depthMask(false);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        gl.useProgram(this.gridProg);
        gl.uniformMatrix4fv(this.uGridVP, false, vp);
        gl.uniform3f(this.uGridCenter, gc.x, gc.y, gc.z);
        gl.uniform1f(this.uGridStep, step);
        gl.uniform1f(this.uGridRadius, Math.max(mr * 4.5, cam.distance() * 1.4));
        gl.uniform1i(this.uGridYup, cam.getUpAxis() === UpAxis.YUp ? 1 : 0);
        gl.uniform1i(this.uGridDark, state.darkTheme ? 1 : 0);

        gl.bindVertexArray(this.lineVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo);
        gl.bufferData(gl.ARRAY_BUFFER, q, gl.STREAM_DRAW);
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        gl.disable(gl.BLEND);
        gl.depthMask(true);
      }

      // Optional 3D Printer Build Plate Outline
      if (state.showBed && state.bedSize) {
        const gc = modelValid
          ? {
              x: (mesh.bboxMin.x + mesh.bboxMax.x) * 0.5,
              y: (mesh.bboxMin.y + mesh.bboxMax.y) * 0.5,
              z: (mesh.bboxMin.z + mesh.bboxMax.z) * 0.5,
            }
          : { x: 0, y: 0, z: 0 };
        const mr = modelValid
          ? Math.max(Math.hypot(mesh.bboxExtent.x, mesh.bboxExtent.y, mesh.bboxExtent.z) * 0.5, 1.0)
          : 50.0;
        const bx = (state.bedSize.x || 220) * 0.5;
        const by = (state.bedSize.y || 220) * 0.5;
        const c = state.darkTheme ? [0.22, 0.56, 0.98, 0.85] : [0.08, 0.28, 0.80, 0.85];
        const bv = [];
        const seg = (a, b) => bv.push(a[0], a[1], a[2], ...c, b[0], b[1], b[2], ...c);
        if (cam.getUpAxis() === UpAxis.ZUp) {
          const gz = modelValid ? mesh.bboxMin.z - mr * 0.0004 : 0.0;
          seg([gc.x - bx, gc.y - by, gz], [gc.x + bx, gc.y - by, gz]);
          seg([gc.x + bx, gc.y - by, gz], [gc.x + bx, gc.y + by, gz]);
          seg([gc.x + bx, gc.y + by, gz], [gc.x - bx, gc.y + by, gz]);
          seg([gc.x - bx, gc.y + by, gz], [gc.x - bx, gc.y - by, gz]);
        } else {
          const gy = modelValid ? mesh.bboxMin.y - mr * 0.0004 : 0.0;
          seg([gc.x - bx, gy, gc.z - by], [gc.x + bx, gy, gc.z - by]);
          seg([gc.x + bx, gy, gc.z - by], [gc.x + bx, gy, gc.z + by]);
          seg([gc.x + bx, gy, gc.z + by], [gc.x - bx, gy, gc.z + by]);
          seg([gc.x - bx, gy, gc.z + by], [gc.x - bx, gy, gc.z - by]);
        }
        if (this.lineScratch.length < bv.length) this.lineScratch = new Float32Array(bv.length);
        this.lineScratch.set(bv);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
        gl.useProgram(this.lineProg);
        gl.uniformMatrix4fv(this.uLineVP, false, vp);
        gl.bindVertexArray(this.lineVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo);
        gl.bufferData(gl.ARRAY_BUFFER, this.lineScratch.subarray(0, bv.length), gl.STREAM_DRAW);
        gl.drawArrays(gl.LINES, 0, (bv.length / 7) | 0);
        gl.disable(gl.BLEND);
        gl.depthMask(true);
      }

      // 3D Measurement pins & line (high-contrast amber + sapphire/cyan)
      if (state.measureHasA) {
        const mv = [];
        const rPin = Math.max(cam.distance() * 0.016, 0.15);
        const pinCol = state.darkTheme ? [1.0, 0.68, 0.16, 1.0] : [0.88, 0.36, 0.04, 1.0];
        const lineCol = state.darkTheme ? [0.24, 0.80, 1.0, 1.0] : [0.06, 0.32, 0.88, 1.0];
        appendDiamond3d(mv, state.measureA, rPin, pinCol);
        if (state.measureHasB) {
          appendDiamond3d(mv, state.measureB, rPin, pinCol);
          mv.push(
            state.measureA.x, state.measureA.y, state.measureA.z, ...lineCol,
            state.measureB.x, state.measureB.y, state.measureB.z, ...lineCol
          );
        }

        if (this.lineScratch.length < mv.length) {
          this.lineScratch = new Float32Array(mv.length);
        }
        this.lineScratch.set(mv);
        const vertCount = (mv.length / 7) | 0;

        gl.useProgram(this.lineProg);
        gl.uniformMatrix4fv(this.uLineVP, false, vp);
        gl.bindVertexArray(this.lineVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo);
        gl.bufferData(gl.ARRAY_BUFFER, this.lineScratch.subarray(0, mv.length), gl.STREAM_DRAW);

        gl.depthMask(false);
        gl.depthFunc(gl.LEQUAL);
        gl.drawArrays(gl.LINES, 0, vertCount);

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthFunc(gl.GREATER);
        for (let i = 6; i < mv.length; i += 7) {
          this.lineScratch[i] *= 0.30;
        }
        gl.bufferData(gl.ARRAY_BUFFER, this.lineScratch.subarray(0, mv.length), gl.STREAM_DRAW);
        gl.drawArrays(gl.LINES, 0, vertCount);
        gl.depthFunc(gl.LESS);
        gl.disable(gl.BLEND);
        gl.depthMask(true);
      }

      // 2. Accumulate sceneColor -> accumFbo
      this.lastCstats = cstats;
      this.accumCount++;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.accumFbo);
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      gl.disable(gl.CULL_FACE);
      if (this.accumCount === 1) {
        gl.disable(gl.BLEND);
      } else {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      }
      gl.useProgram(this.accumProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.sceneColor);
      gl.uniform1i(this.uAccumTex, 0);
      gl.uniform1f(this.uAccumWeight, 1.0 / this.accumCount);
      gl.bindVertexArray(this.emptyVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.disable(gl.BLEND);
    }

    // 3. Resolve accumColor -> default framebuffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);

    gl.useProgram(this.resolveProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.accumColor);
    gl.uniform1i(this.uResolveTex, 0);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 4. Bottom-right crisp 3D Axis Triad
    let axisTipsCss = null;
    if (state.showHud) {
      const v = cam.viewMatrix();
      const cssW = this.width / this.dpr;
      const cssH = this.height / this.dpr;
      const cxCss = state.triadCenterCss ? state.triadCenterCss.x : cssW - 54.0;
      const cyCss = state.triadCenterCss ? state.triadCenterCss.y : cssH - 54.0;
      const armCss = 22.0;
      const labelArmCss = 33.0;

      const dirs = [
        [v[0], v[1], v[2]],
        [v[4], v[5], v[6]],
        [v[8], v[9], v[10]],
      ];
      const cols = state.darkTheme
        ? [[0.96, 0.36, 0.32, 1.0], [0.34, 0.88, 0.42, 1.0], [0.36, 0.64, 0.98, 1.0]]
        : [[0.82, 0.18, 0.16, 1.0], [0.14, 0.60, 0.20, 1.0], [0.12, 0.40, 0.84, 1.0]];

      const ox = (cxCss / cssW) * 2.0 - 1.0;
      const oy = 1.0 - (cyCss / cssH) * 2.0;

      axisTipsCss = new Array(3);
      const tr = this.triadScratch;
      for (let i = 0; i < 3; i++) {
        const sxCss = cxCss + dirs[i][0] * armCss;
        const syCss = cyCss - dirs[i][1] * armCss;
        axisTipsCss[i] = {
          x: cxCss + dirs[i][0] * labelArmCss,
          y: cyCss - dirs[i][1] * labelArmCss,
        };
        const ex = (sxCss / cssW) * 2.0 - 1.0;
        const ey = 1.0 - (syCss / cssH) * 2.0;
        const base = i * 14;
        tr[base + 0] = ox; tr[base + 1] = oy; tr[base + 2] = 0;
        tr[base + 3] = cols[i][0]; tr[base + 4] = cols[i][1]; tr[base + 5] = cols[i][2]; tr[base + 6] = 1;
        tr[base + 7] = ex; tr[base + 8] = ey; tr[base + 9] = 0;
        tr[base + 10] = cols[i][0]; tr[base + 11] = cols[i][1]; tr[base + 12] = cols[i][2]; tr[base + 13] = 1;
      }

      gl.useProgram(this.lineProg);
      gl.uniformMatrix4fv(this.uLineVP, false, Mat4.identity());
      gl.bindVertexArray(this.lineVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo);
      gl.bufferData(gl.ARRAY_BUFFER, tr, gl.STREAM_DRAW);
      gl.drawArrays(gl.LINES, 0, 6);
    }

    gl.bindVertexArray(null);
    gl.useProgram(null);
    return { cstats, axisTipsCss, accumCount: this.accumCount };
  }

  pickWorldPoint(cssX, cssY, cam, mesh, state) {
    if (!this.hasMesh || !mesh || !mesh.ok) return null;
    const gl = this.gl;
    this._ensurePickFbo();

    const px = Math.max(0, Math.min(this.width - 1, Math.round(cssX * this.dpr)));
    const py = Math.max(0, Math.min(this.height - 1, Math.round(cssY * this.dpr)));
    const glY = this.height - 1 - py;

    const ndcX = ((px + 0.5) / this.width) * 2.0 - 1.0;
    const ndcY = ((glY + 0.5) / this.height) * 2.0 - 1.0;

    const pPick = new Float32Array([
      this.width, 0, 0, 0,
      0, this.height, 0, 0,
      0, 0, 1, 0,
      -ndcX * this.width, -ndcY * this.height, 0, 1,
    ]);

    const vp = cam.viewProj(this.width, this.height);
    const pickVP = Mat4.multiply(pPick, vp);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);
    gl.viewport(0, 0, 1, 1);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.depthFunc(gl.LESS);

    const useCull = !state.twoSided && !state.sliceEnabled && !state.xray;
    if (useCull) {
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
      gl.frontFace(gl.CCW);
    } else {
      gl.disable(gl.CULL_FACE);
    }

    gl.clearColor(1.0, 1.0, 1.0, 0.0);
    gl.clearDepth(1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const clipPlane = this._computeClipPlane(mesh, state);
    gl.useProgram(this.pickProg);
    gl.uniformMatrix4fv(this.uPickVP, false, pickVP);
    gl.uniform3f(this.uPickBmin, mesh.bboxMin.x, mesh.bboxMin.y, mesh.bboxMin.z);
    gl.uniform3f(this.uPickQscale, mesh.quantScale.x, mesh.quantScale.y, mesh.quantScale.z);
    gl.uniform4f(this.uPickClipPlane, clipPlane[0], clipPlane[1], clipPlane[2], clipPlane[3]);
    gl.uniform1i(this.uPickClipOn, state.sliceEnabled ? 1 : 0);

    gl.bindVertexArray(this.meshVao);
    gl.drawArrays(gl.TRIANGLES, 0, mesh.triCount * 3);

    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.pickPixel);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);

    if (this.pickPixel[3] === 0) return null;
    const zi = (this.pickPixel[0] << 16) | (this.pickPixel[1] << 8) | this.pickPixel[2];
    const depth = zi / 16777215.0;
    if (depth >= 0.99999) return null;

    const invVP = Mat4.inverse(vp);
    if (!invVP) return null;
    return Mat4.unproject({ x: px + 0.5, y: glY + 0.5, z: depth }, invVP, this.width, this.height);
  }
}
