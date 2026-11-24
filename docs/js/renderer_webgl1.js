import { Mat4, Frustum } from './math3d.js';
import { UpAxis } from './camera.js';
import { MATCAP_SIZE, MatcapKind, generateMatcapRgba8 } from './matcap.js';
import { cullChunks } from './culling.js';
import { pickMeshCpu } from './picking.js';

const BG_VS = `
attribute vec2 aPos;
varying vec2 vUV;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
  vUV = aPos * 0.5 + 0.5;
}
`;

function makeBgFs(prec) {
  return `
precision ${prec} float;
precision mediump int;
varying vec2 vUV;
uniform int uDark;
void main() {
  float t = clamp(vUV.y, 0.0, 1.0);
  vec2 d = vUV - vec2(0.5);
  float vig = dot(d, d) * 0.35;
  vec3 col;
  if (uDark != 0) {
    // sRGB-matched to WebGL2 resolve output (Obsidian Studio)
    vec3 bot = vec3(0.086, 0.102, 0.133);
    vec3 top = vec3(0.157, 0.180, 0.224);
    col = mix(bot, top, smoothstep(0.0, 1.0, t)) * (1.0 - vig * 0.32);
  } else {
    // sRGB-matched to WebGL2 resolve output (Alabaster Drafting)
    vec3 bot = vec3(0.75, 0.79, 0.84);
    vec3 top = vec3(0.92, 0.94, 0.96);
    col = mix(bot, top, smoothstep(0.0, 1.0, t)) * (1.0 - vig * 0.08);
  }
  gl_FragColor = vec4(col, 1.0);
}
`;
}

function makeMeshVs(prec, hasDeriv) {
  return `
precision ${prec} float;
precision mediump int;
attribute vec4 aPos;
${hasDeriv ? 'attribute vec3 aBary;' : 'attribute vec3 aNorm;'}

uniform mat4 uView;
uniform mat4 uProj;
uniform vec3 uBboxMin;
uniform vec3 uQuantScale;
uniform vec4 uClipPlane;
uniform int uClipOn;

varying vec3 vViewPos;
varying vec3 vWorldPos;
${hasDeriv ? 'varying vec3 vBary;' : 'varying vec3 vViewNorm;\nvarying vec3 vWorldNorm;'}
varying float vClipDist;

void main() {
  vec3 worldPos = uBboxMin + aPos.xyz * uQuantScale;
  vWorldPos = worldPos;
  vec4 vp = uView * vec4(worldPos, 1.0);
  vViewPos = vp.xyz;
  vClipDist = (uClipOn != 0) ? dot(vec4(worldPos, 1.0), uClipPlane) : 1.0;
  ${hasDeriv ? 'vBary = aBary;' : 'vViewNorm = (uView * vec4(aNorm, 0.0)).xyz;\nvWorldNorm = aNorm;'}
  gl_Position = uProj * vp;
}
`;
}

function makeMeshFs(prec, hasDeriv) {
  const ext = hasDeriv ? '#extension GL_OES_standard_derivatives : enable\n' : '';
  return `${ext}precision ${prec} float;
precision mediump int;
varying vec3 vViewPos;
varying vec3 vWorldPos;
${hasDeriv ? 'varying vec3 vBary;' : 'varying vec3 vViewNorm;\nvarying vec3 vWorldNorm;'}
varying float vClipDist;

uniform sampler2D uMatcap;
uniform int uClipOn;
uniform int uXray;
uniform int uWire;
uniform int uDark;
uniform int uOverhang;
uniform int uYUp;

void main() {
  if (uClipOn != 0 && vClipDist < 0.0) discard;

  ${
    hasDeriv
      ? `vec3 dpdx = dFdx(vViewPos);
  vec3 dpdy = dFdy(vViewPos);
  vec3 crossN = cross(dpdx, dpdy);
  float len2 = dot(crossN, crossN);
  vec3 N = (len2 > 1e-20) ? (crossN * inversesqrt(len2)) : vec3(0.0, 0.0, 1.0);`
      : `float len2 = dot(vViewNorm, vViewNorm);
  vec3 N = (len2 > 1e-12) ? (vViewNorm * inversesqrt(len2)) : vec3(0.0, 0.0, 1.0);`
  }

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
    col = texture2D(uMatcap, uv).rgb;
    if (backFace) {
      vec3 backTint = vec3(0.55, 0.22, 0.14);
      col = mix(col * 0.75, backTint * (0.45 + 0.65 * clamp(N.z, 0.0, 1.0)), 0.68);
    } else if (uOverhang != 0) {
      ${
        hasDeriv
          ? `vec3 wn = cross(dFdx(vWorldPos), dFdy(vWorldPos));
      float wl2 = dot(wn, wn);
      if (wl2 > 1e-20) {
        wn *= inversesqrt(wl2);`
          : `vec3 wn = vWorldNorm;
      float wl2 = dot(wn, wn);
      if (wl2 > 1e-12) {
        wn *= inversesqrt(wl2);`
      }
        float upDot = (uYUp != 0) ? wn.y : wn.z;
        if (upDot < -0.70710678) {
          vec3 coral = vec3(0.95, 0.30, 0.22) * (0.45 + 0.55 * clamp(N.z, 0.0, 1.0));
          col = mix(col * 0.30, coral, 0.82);
        }
      }
    }
  }

  ${
    hasDeriv
      ? `if (uWire != 0) {
    vec3 fw = max(fwidth(vBary), vec3(1e-5));
    vec3 f = smoothstep(vec3(0.0), fw * 1.35, vBary);
    float edge = 1.0 - min(min(f.x, f.y), f.z);
    vec3 wc = (uDark != 0) ? vec3(0.24, 0.58, 0.96) : vec3(0.05, 0.18, 0.40);
    col = mix(col, wc, edge * 0.78);
    alpha = max(alpha, edge * 0.85);
  }`
      : ''
  }

  gl_FragColor = vec4(col, alpha);
}
`;
}

const LINE_VS = `
attribute vec3 aPos;
attribute vec4 aCol;
uniform mat4 uVP;
varying vec4 vCol;
void main() {
  gl_Position = uVP * vec4(aPos, 1.0);
  vCol = aCol;
}
`;

function makeLineFs(prec) {
  return `
precision ${prec} float;
varying vec4 vCol;
void main() {
  gl_FragColor = vCol;
}
`;
}

function compileProgram(gl, vsSrc, fsSrc, tag) {
  const comp = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error(`${tag} WebGL1 shader compile error: ${log}`);
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
    throw new Error(`${tag} WebGL1 program link error: ${log}`);
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

export class RendererWebGL1 {
  constructor(canvas) {
    this.canvas = canvas;
    this.backend = 'WebGL1';
    this.needsCpuVertices = true;
    this.gl = null;
    this.width = 1;
    this.height = 1;
    this.dpr = 1;
    this.fp16Fbo = false;
    this.accumCount = 0;
    this.targetSamples = 1;
    this.hasMesh = false;
    this.glInfo = '';
    this.hasDeriv = false;

    this.bgVbo = null;
    this.meshVbo = null;
    this.baryVbo = null;
    this.normVbo = null;
    this.wireVbo = null;
    this.wireVertCount = 0;
    this.lineVbo = null;
    this.matcapTex = [];
    this.triCount = 0;
    this.baryUploadedFor = 0;
    this.wireUploadedFor = 0;
    this.lineScratch = new Float32Array(512);
    this.triadScratch = new Float32Array(42);
  }

  init(width, height, dpr) {
    const opts = {
      antialias: true,
      alpha: false,
      depth: true,
      stencil: false,
      powerPreference: 'low-power',
      preserveDrawingBuffer: false,
    };
    let gl = this.canvas.getContext('webgl', opts) || this.canvas.getContext('experimental-webgl', opts);
    if (!gl) {
      gl = this.canvas.getContext('webgl') || this.canvas.getContext('experimental-webgl');
    }
    if (!gl) {
      throw new Error('WebGL1 is not supported by this browser/GPU.');
    }
    this.gl = gl;
    this.width = Math.max(1, width | 0);
    this.height = Math.max(1, height | 0);
    this.dpr = dpr || 1;

    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    this.glInfo = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);

    const hp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    const prec = hp && hp.precision > 0 ? 'highp' : 'mediump';
    this.hasDeriv = !!gl.getExtension('OES_standard_derivatives');

    this.bgProg = compileProgram(gl, BG_VS, makeBgFs(prec), 'bg');
    this.aBgPos = gl.getAttribLocation(this.bgProg, 'aPos');
    this.uBgDark = gl.getUniformLocation(this.bgProg, 'uDark');

    this.meshProg = compileProgram(gl, makeMeshVs(prec, this.hasDeriv), makeMeshFs(prec, this.hasDeriv), 'mesh');
    this.aMeshPos = gl.getAttribLocation(this.meshProg, 'aPos');
    this.aMeshExtra = gl.getAttribLocation(this.meshProg, this.hasDeriv ? 'aBary' : 'aNorm');
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

    this.lineProg = compileProgram(gl, LINE_VS, makeLineFs(prec), 'line');
    this.aLinePos = gl.getAttribLocation(this.lineProg, 'aPos');
    this.aLineCol = gl.getAttribLocation(this.lineProg, 'aCol');
    this.uLineVP = gl.getUniformLocation(this.lineProg, 'uVP');

    this.bgVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bgVbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    this.meshVbo = gl.createBuffer();
    this.baryVbo = gl.createBuffer();
    this.normVbo = gl.createBuffer();
    this.wireVbo = gl.createBuffer();
    this.lineVbo = gl.createBuffer();

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    for (let i = 0; i < MatcapKind.Count; i++) {
      const tex = gl.createTexture();
      const pixels = generateMatcapRgba8(i);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, MATCAP_SIZE, MATCAP_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.matcapTex.push(tex);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.accumCount = 0;
  }

  resize(width, height, dpr) {
    const w = Math.max(1, width | 0);
    const h = Math.max(1, height | 0);
    this.dpr = dpr || 1;
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.accumCount = 0;
  }

  setTargetSamples() {
    this.targetSamples = 1;
  }

  resetAccumulation() {
    this.accumCount = 0;
  }

  needsMoreSamples() {
    return this.accumCount < 1;
  }

  uploadMesh(mesh) {
    const gl = this.gl;
    if (!mesh || !mesh.ok || !mesh.vertices || mesh.vertices.length === 0) {
      this.hasMesh = false;
      this.triCount = 0;
      return;
    }
    this.triCount = mesh.triCount;
    this.baryUploadedFor = 0;
    this.wireUploadedFor = 0;

    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshVbo);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);

    if (!this.hasDeriv) {
      const v = mesh.vertices;
      const sx = mesh.quantScale.x / 65535.0;
      const sy = mesh.quantScale.y / 65535.0;
      const sz = mesh.quantScale.z / 65535.0;
      const norms = new Int8Array(mesh.triCount * 9);
      for (let t = 0; t < mesh.triCount; t++) {
        const b = t * 12;
        const x0 = v[b] * sx, y0 = v[b + 1] * sy, z0 = v[b + 2] * sz;
        const e1x = v[b + 4] * sx - x0, e1y = v[b + 5] * sy - y0, e1z = v[b + 6] * sz - z0;
        const e2x = v[b + 8] * sx - x0, e2y = v[b + 9] * sy - y0, e2z = v[b + 10] * sz - z0;
        let nx = e1y * e2z - e1z * e2y;
        let ny = e1z * e2x - e1x * e2z;
        let nz = e1x * e2y - e1y * e2x;
        const l = Math.hypot(nx, ny, nz);
        if (l > 1e-12) {
          nx /= l; ny /= l; nz /= l;
        } else {
          nx = 0; ny = 0; nz = 1;
        }
        const qx = Math.max(-127, Math.min(127, Math.round(nx * 127)));
        const qy = Math.max(-127, Math.min(127, Math.round(ny * 127)));
        const qz = Math.max(-127, Math.min(127, Math.round(nz * 127)));
        const nb = t * 9;
        norms[nb] = qx; norms[nb + 1] = qy; norms[nb + 2] = qz;
        norms[nb + 3] = qx; norms[nb + 4] = qy; norms[nb + 5] = qz;
        norms[nb + 6] = qx; norms[nb + 7] = qy; norms[nb + 8] = qz;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.normVbo);
      gl.bufferData(gl.ARRAY_BUFFER, norms, gl.STATIC_DRAW);
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.hasMesh = true;
    this.accumCount = 0;
  }

  _ensureBaryBuffer(mesh) {
    if (this.baryUploadedFor === mesh.triCount) return;
    const bary = new Uint8Array(mesh.triCount * 9);
    for (let t = 0; t < mesh.triCount; t++) {
      const b = t * 9;
      bary[b] = 255;
      bary[b + 4] = 255;
      bary[b + 8] = 255;
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.baryVbo);
    gl.bufferData(gl.ARRAY_BUFFER, bary, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.baryUploadedFor = mesh.triCount;
  }

  _ensureWireLineBuffer(mesh) {
    if (this.wireUploadedFor === mesh.triCount) return;
    const gl = this.gl;
    const v = mesh.vertices;
    const bmin = mesh.bboxMin;
    const sx = mesh.quantScale.x / 65535.0;
    const sy = mesh.quantScale.y / 65535.0;
    const sz = mesh.quantScale.z / 65535.0;
    const buf = new Float32Array(mesh.triCount * 6 * 3);
    for (let t = 0; t < mesh.triCount; t++) {
      const vb = t * 12;
      const x0 = bmin.x + v[vb] * sx, y0 = bmin.y + v[vb + 1] * sy, z0 = bmin.z + v[vb + 2] * sz;
      const x1 = bmin.x + v[vb + 4] * sx, y1 = bmin.y + v[vb + 5] * sy, z1 = bmin.z + v[vb + 6] * sz;
      const x2 = bmin.x + v[vb + 8] * sx, y2 = bmin.y + v[vb + 9] * sy, z2 = bmin.z + v[vb + 10] * sz;
      const ob = t * 18;
      buf[ob + 0] = x0; buf[ob + 1] = y0; buf[ob + 2] = z0;
      buf[ob + 3] = x1; buf[ob + 4] = y1; buf[ob + 5] = z1;
      buf[ob + 6] = x1; buf[ob + 7] = y1; buf[ob + 8] = z1;
      buf[ob + 9] = x2; buf[ob + 10] = y2; buf[ob + 11] = z2;
      buf[ob + 12] = x2; buf[ob + 13] = y2; buf[ob + 14] = z2;
      buf[ob + 15] = x0; buf[ob + 16] = y0; buf[ob + 17] = z0;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.wireVbo);
    gl.bufferData(gl.ARRAY_BUFFER, buf, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.wireVertCount = mesh.triCount * 6;
    this.wireUploadedFor = mesh.triCount;
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

  _drawLines(verts, vertCount, vp) {
    const gl = this.gl;
    if (this.lineScratch.length < verts.length) {
      this.lineScratch = new Float32Array(verts.length);
    }
    this.lineScratch.set(verts);
    gl.useProgram(this.lineProg);
    gl.uniformMatrix4fv(this.uLineVP, false, vp);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.lineScratch.subarray(0, verts.length), gl.STREAM_DRAW);
    gl.enableVertexAttribArray(this.aLinePos);
    gl.vertexAttribPointer(this.aLinePos, 3, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(this.aLineCol);
    gl.vertexAttribPointer(this.aLineCol, 4, gl.FLOAT, false, 28, 12);
    gl.drawArrays(gl.LINES, 0, vertCount);
    gl.disableVertexAttribArray(this.aLinePos);
    gl.disableVertexAttribArray(this.aLineCol);
  }

  renderFrame(mesh, cam, state) {
    const gl = this.gl;
    let cstats = {
      totalChunks: 0, frustumCulled: 0, coneCulled: 0,
      visibleChunks: 0, visibleTris: 0, drawCalls: 0,
    };

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);

    // 1. Background gradient
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);

    gl.useProgram(this.bgProg);
    gl.uniform1i(this.uBgDark, state.darkTheme ? 1 : 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bgVbo);
    gl.enableVertexAttribArray(this.aBgPos);
    gl.vertexAttribPointer(this.aBgPos, 2, gl.FLOAT, false, 8, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disableVertexAttribArray(this.aBgPos);

    gl.depthMask(true);
    gl.clearDepth(1.0);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);

    const view = cam.viewMatrix();
    const proj = cam.projMatrix(this.width, this.height);
    const vp = Mat4.multiply(proj, view);
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

      const fr = Frustum.fromViewProj(vp);
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
      gl.uniform1i(this.uMeshWire, state.wireframe && this.hasDeriv ? 1 : 0);
      gl.uniform1i(this.uMeshOverhang, state.overhang ? 1 : 0);
      gl.uniform1i(this.uMeshYUp, cam.getUpAxis() === UpAxis.YUp ? 1 : 0);

      const mc = Math.max(0, Math.min(MatcapKind.Count - 1, state.matcap | 0));
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.matcapTex[mc]);
      gl.uniform1i(this.uMeshMatcap, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.meshVbo);
      gl.enableVertexAttribArray(this.aMeshPos);
      gl.vertexAttribPointer(this.aMeshPos, 4, gl.UNSIGNED_SHORT, true, 8, 0);

      if (this.aMeshExtra >= 0) {
        if (this.hasDeriv) {
          if (state.wireframe) {
            this._ensureBaryBuffer(mesh);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.baryVbo);
            gl.enableVertexAttribArray(this.aMeshExtra);
            gl.vertexAttribPointer(this.aMeshExtra, 3, gl.UNSIGNED_BYTE, true, 3, 0);
          } else {
            gl.disableVertexAttribArray(this.aMeshExtra);
            gl.vertexAttrib3f(this.aMeshExtra, 1.0, 0.0, 0.0);
          }
        } else {
          gl.bindBuffer(gl.ARRAY_BUFFER, this.normVbo);
          gl.enableVertexAttribArray(this.aMeshExtra);
          gl.vertexAttribPointer(this.aMeshExtra, 3, gl.BYTE, true, 3, 0);
        }
      }

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

      gl.disableVertexAttribArray(this.aMeshPos);
      if (this.aMeshExtra >= 0) gl.disableVertexAttribArray(this.aMeshExtra);

      if (state.wireframe && !this.hasDeriv && !state.sliceEnabled) {
        this._ensureWireLineBuffer(mesh);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthFunc(gl.LEQUAL);
        gl.useProgram(this.lineProg);
        gl.uniformMatrix4fv(this.uLineVP, false, vp);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.wireVbo);
        gl.enableVertexAttribArray(this.aLinePos);
        gl.vertexAttribPointer(this.aLinePos, 3, gl.FLOAT, false, 12, 0);
        gl.disableVertexAttribArray(this.aLineCol);
        if (state.darkTheme) gl.vertexAttrib4f(this.aLineCol, 0.24, 0.58, 0.96, 0.45);
        else gl.vertexAttrib4f(this.aLineCol, 0.05, 0.18, 0.40, 0.45);
        gl.drawArrays(gl.LINES, 0, this.wireVertCount);
        gl.disableVertexAttribArray(this.aLinePos);
        gl.depthFunc(gl.LESS);
        gl.disable(gl.BLEND);
      }
    }

    // 2. Ground Grid (line-based)
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
      const logS = Math.floor(Math.log10(Math.max(mr * 0.45, 0.05)));
      const step = Math.pow(10.0, logS);
      const count = 12;
      const halfSpan = count * step;
      const minorC = state.darkTheme ? [0.22, 0.26, 0.34, 0.35] : [0.30, 0.35, 0.42, 0.35];
      const majorC = state.darkTheme ? [0.32, 0.38, 0.48, 0.55] : [0.20, 0.25, 0.32, 0.50];
      const xC = state.darkTheme ? [0.78, 0.28, 0.28, 0.72] : [0.72, 0.18, 0.18, 0.72];
      const yC = cam.getUpAxis() === UpAxis.YUp
        ? (state.darkTheme ? [0.28, 0.52, 0.85, 0.72] : [0.16, 0.36, 0.72, 0.72])
        : (state.darkTheme ? [0.26, 0.70, 0.36, 0.72] : [0.16, 0.54, 0.22, 0.72]);

      const gv = [];
      if (cam.getUpAxis() === UpAxis.ZUp) {
        const gz = modelValid ? mesh.bboxMin.z - mr * 0.001 : 0.0;
        const cx = Math.round(gc.x / step) * step;
        const cy = Math.round(gc.y / step) * step;
        for (let i = -count; i <= count; i++) {
          const x = cx + i * step;
          const y = cy + i * step;
          const colX = Math.abs(y) < step * 0.01 ? xC : (Math.round(y / step) % 5 === 0 ? majorC : minorC);
          const colY = Math.abs(x) < step * 0.01 ? yC : (Math.round(x / step) % 5 === 0 ? majorC : minorC);
          gv.push(cx - halfSpan, y, gz, ...colX, cx + halfSpan, y, gz, ...colX);
          gv.push(x, cy - halfSpan, gz, ...colY, x, cy + halfSpan, gz, ...colY);
        }
      } else {
        const gy = modelValid ? mesh.bboxMin.y - mr * 0.001 : 0.0;
        const cx = Math.round(gc.x / step) * step;
        const cz = Math.round(gc.z / step) * step;
        for (let i = -count; i <= count; i++) {
          const x = cx + i * step;
          const z = cz + i * step;
          const colX = Math.abs(z) < step * 0.01 ? xC : (Math.round(z / step) % 5 === 0 ? majorC : minorC);
          const colZ = Math.abs(x) < step * 0.01 ? yC : (Math.round(x / step) % 5 === 0 ? majorC : minorC);
          gv.push(cx - halfSpan, gy, z, ...colX, cx + halfSpan, gy, z, ...colX);
          gv.push(x, gy, cz - halfSpan, ...colZ, x, gy, cz + halfSpan, ...colZ);
        }
      }

      gl.depthMask(false);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      this._drawLines(gv, (gv.length / 7) | 0, vp);
      gl.disable(gl.BLEND);
      gl.depthMask(true);
    }

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
      const c = state.darkTheme ? [0.31, 0.61, 0.98, 0.85] : [0.15, 0.39, 0.92, 0.85];
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
      gl.depthMask(false);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      this._drawLines(bv, (bv.length / 7) | 0, vp);
      gl.disable(gl.BLEND);
      gl.depthMask(true);
    }

    // 3. Measurement pins & line
    if (state.measureHasA) {
      const mv = [];
      const rPin = Math.max(cam.distance() * 0.012, 0.1);
      const pinCol = [0.98, 0.62, 0.15, 1.0];
      const lineCol = [0.35, 0.78, 1.0, 1.0];
      appendDiamond3d(mv, state.measureA, rPin, pinCol);
      if (state.measureHasB) {
        appendDiamond3d(mv, state.measureB, rPin, pinCol);
        mv.push(
          state.measureA.x, state.measureA.y, state.measureA.z, ...lineCol,
          state.measureB.x, state.measureB.y, state.measureB.z, ...lineCol
        );
      }
      const vCount = (mv.length / 7) | 0;
      gl.depthMask(false);
      gl.depthFunc(gl.LEQUAL);
      this._drawLines(mv, vCount, vp);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthFunc(gl.GREATER);
      for (let i = 6; i < mv.length; i += 7) mv[i] *= 0.30;
      this._drawLines(mv, vCount, vp);
      gl.depthFunc(gl.LESS);
      gl.disable(gl.BLEND);
      gl.depthMask(true);
    }

    // 4. Bottom-right 3D Axis Triad
    let axisTipsCss = null;
    if (state.showHud) {
      const v = view;
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

      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      this._drawLines(tr, 6, Mat4.identity());
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.useProgram(null);
    this.accumCount = 1;
    return { cstats, axisTipsCss, accumCount: 1 };
  }

  pickWorldPoint(cssX, cssY, cam, mesh, state) {
    return pickMeshCpu(cssX, cssY, this.width, this.height, this.dpr, cam, mesh, state);
  }
}
