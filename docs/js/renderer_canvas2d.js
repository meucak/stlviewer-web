import { Mat4, Frustum } from './math3d.js';
import { UpAxis } from './camera.js';
import { MATCAP_SIZE, MatcapKind, generateMatcapRgba8 } from './matcap.js';
import { cullChunks } from './culling.js';
import { pickMeshCpu } from './picking.js';

const INV_65535 = 1.0 / 65535.0;
const FAST_TRI_LIMIT = 24000;
const OVERHANG_COS = -0.70710678; // 45 degrees downward

function clipPolygonPlane(pts, plane) {
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const da = a.x * plane[0] + a.y * plane[1] + a.z * plane[2] + plane[3];
    const db = b.x * plane[0] + b.y * plane[1] + b.z * plane[2] + plane[3];
    if (da >= 0) {
      out.push(a);
      if (db < 0) {
        const t = da / (da - db);
        out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
      }
    } else if (db >= 0) {
      const t = da / (da - db);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
    }
  }
  return out;
}

export class RendererCanvas2D {
  constructor(canvas) {
    this.canvas = canvas;
    this.backend = 'Canvas 2D';
    this.needsCpuVertices = true;
    this.ctx = null;
    this.width = 1;
    this.height = 1;
    this.dpr = 1;
    this.fp16Fbo = false;
    this.accumCount = 0;
    this.targetSamples = 1;
    this.hasMesh = false;
    this.glInfo = 'Software Z-Buffer 2D Rasterizer';
    this.matcapTables = [];
    this.triList = [];
    this.imgData = null;
    this.zbuf = null;
    this.useZBuffer = false;
  }

  init(width, height, dpr) {
    const ctx = this.canvas.getContext('2d', { alpha: false }) || this.canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Canvas 2D context is unavailable.');
    }
    this.ctx = ctx;
    this.useZBuffer =
      typeof ctx.createImageData === 'function' && typeof ctx.putImageData === 'function';
    this.width = Math.max(1, width | 0);
    this.height = Math.max(1, height | 0);
    this.dpr = dpr || 1;
    for (let i = 0; i < MatcapKind.Count; i++) {
      this.matcapTables.push(generateMatcapRgba8(i));
    }
    this._allocBuffers();
    this.accumCount = 0;
  }

  _allocBuffers() {
    if (!this.useZBuffer || !this.ctx) return;
    if (!this.imgData || this.imgData.width !== this.width || this.imgData.height !== this.height) {
      this.imgData = this.ctx.createImageData(this.width, this.height);
      this.zbuf = new Float32Array(this.width * this.height);
    }
  }

  resize(width, height, dpr) {
    const w = Math.max(1, width | 0);
    const h = Math.max(1, height | 0);
    this.dpr = dpr || 1;
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this._allocBuffers();
    this.accumCount = 0;
  }

  setTargetSamples() {
    this.targetSamples = 1;
  }

  resetAccumulation() {
    this.accumCount = 0;
  }

  needsMoreSamples() {
    return this.accumCount < this.targetSamples;
  }

  uploadMesh(mesh) {
    this.hasMesh = !!(mesh && mesh.ok && mesh.vertices && mesh.vertices.length > 0);
    this.targetSamples = this.hasMesh && mesh.triCount > FAST_TRI_LIMIT ? 2 : 1;
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

  _projectPoint(vp, x, y, z) {
    const cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12];
    const cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13];
    const cz = vp[2] * x + vp[6] * y + vp[10] * z + vp[14];
    const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
    if (cw <= 1e-5) return null;
    const invW = 1.0 / cw;
    return {
      sx: (cx * invW * 0.5 + 0.5) * this.width,
      sy: (1.0 - (cy * invW * 0.5 + 0.5)) * this.height,
      z: cz * invW,
    };
  }

  _drawLine3DCtx(ctx, vp, ax, ay, az, bx, by, bz, color, widthPx = 1) {
    const pa = this._projectPoint(vp, ax, ay, az);
    const pb = this._projectPoint(vp, bx, by, bz);
    if (!pa || !pb) return;
    if (pa.z > 1.05 && pb.z > 1.05) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = widthPx;
    ctx.beginPath();
    ctx.moveTo(pa.sx, pa.sy);
    ctx.lineTo(pb.sx, pb.sy);
    ctx.stroke();
  }

  _drawLine3DZBuf(vp, ax, ay, az, bx, by, bz, r, g, b, a) {
    const pa = this._projectPoint(vp, ax, ay, az);
    const pb = this._projectPoint(vp, bx, by, bz);
    if (!pa || !pb) return;
    if (pa.z > 1.0 && pb.z > 1.0) return;

    const w = this.width;
    const h = this.height;
    const data = this.imgData.data;
    const zbuf = this.zbuf;

    const dx = pb.sx - pa.sx;
    const dy = pb.sy - pa.sy;
    const steps = Math.max(1, Math.min(Math.max(w, h) * 2, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)))));
    const invS = 1.0 / steps;
    const dz = (pb.z - pa.z) * invS;
    const sx = dx * invS;
    const sy = dy * invS;
    const invA = 1.0 - a;

    let x = pa.sx;
    let y = pa.sy;
    let z = pa.z;

    for (let i = 0; i <= steps; i++) {
      const ix = x | 0;
      const iy = y | 0;
      if (ix >= 0 && ix < w && iy >= 0 && iy < h && z >= -1.0 && z <= 1.0) {
        const pi = iy * w + ix;
        if (z <= zbuf[pi] + 1e-4) {
          const o = pi * 4;
          data[o] = (data[o] * invA + r * a) | 0;
          data[o + 1] = (data[o + 1] * invA + g * a) | 0;
          data[o + 2] = (data[o + 2] * invA + b * a) | 0;
        }
      }
      x += sx;
      y += sy;
      z += dz;
    }
  }

  _fillBackgroundZBuf(darkTheme) {
    const w = this.width;
    const h = this.height;
    const data = this.imgData.data;
    this.zbuf.fill(2.0);

    // Match WebGL2 studio vignette & vertical gradient (sRGB linear->display calibrated)
    const topR = darkTheme ? 24 : 230;
    const topG = darkTheme ? 28 : 235;
    const topB = darkTheme ? 37 : 242;
    const botR = darkTheme ? 14 : 184;
    const botG = darkTheme ? 17 : 194;
    const botB = darkTheme ? 23 : 206;

    const invH = h > 1 ? 1.0 / (h - 1) : 0;
    for (let y = 0; y < h; y++) {
      const t = y * invH;
      const st = t * t * (3.0 - 2.0 * t);
      const r = (topR + (botR - topR) * st) | 0;
      const g = (topG + (botG - topG) * st) | 0;
      const b = (topB + (botB - topB) * st) | 0;
      let o = y * w * 4;
      for (let x = 0; x < w; x++) {
        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = b;
        data[o + 3] = 255;
        o += 4;
      }
    }
  }

  _rasterizeTriZBuf(p0, p1, p2, r, g, b, alpha, wire, wr, wg, wb, xray) {
    const w = this.width;
    const h = this.height;
    const x0 = p0.sx, y0 = p0.sy, z0 = p0.z;
    const x1 = p1.sx, y1 = p1.sy, z1 = p1.z;
    const x2 = p2.sx, y2 = p2.sy, z2 = p2.z;

    let area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
    if (Math.abs(area) < 1e-4) return;

    // Ensure positive signed screen area for consistent half-space inequalities
    let ax = x0, ay = y0, az = z0;
    let bx = x1, by = y1, bz = z1;
    let cx = x2, cy = y2, cz = z2;
    if (area < 0) {
      bx = x2; by = y2; bz = z2;
      cx = x1; cy = y1; cz = z1;
      area = -area;
    }

    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const maxX = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx)));
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const maxY = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy)));
    if (minX > maxX || minY > maxY) return;

    const invArea = 1.0 / area;
    const a12 = by - cy, b12 = cx - bx;
    const a20 = cy - ay, b20 = ax - cx;
    const a01 = ay - by, b01 = bx - ax;

    // Slight inclusive tolerance (-1e-3 px^2) guarantees watertight shared edges with zero pinpoint cracks
    const edgeEps = -1e-3;
    const px0 = minX + 0.5;
    const py0 = minY + 0.5;
    let w0Row = (cx - bx) * (py0 - by) - (cy - by) * (px0 - bx);
    let w1Row = (ax - cx) * (py0 - cy) - (ay - cy) * (px0 - cx);
    let w2Row = (bx - ax) * (py0 - ay) - (by - ay) * (px0 - ax);

    const data = this.imgData.data;
    const zbuf = this.zbuf;

    // Edge distance scale for wireframe lines (~1.15 px thickness)
    let e0Thresh = 0, e1Thresh = 0, e2Thresh = 0;
    if (wire) {
      e0Thresh = Math.hypot(cx - bx, cy - by) * 1.15;
      e1Thresh = Math.hypot(ax - cx, ay - cy) * 1.15;
      e2Thresh = Math.hypot(bx - ax, by - ay) * 1.15;
    }

    const invAlpha = 1.0 - alpha;

    for (let y = minY; y <= maxY; y++) {
      let w0 = w0Row;
      let w1 = w1Row;
      let w2 = w2Row;
      let pi = y * w + minX;

      for (let x = minX; x <= maxX; x++, pi++) {
        if (w0 >= edgeEps && w1 >= edgeEps && w2 >= edgeEps) {
          const z = (w0 * az + w1 * bz + w2 * cz) * invArea;
          if (z >= -1.0 && z <= 1.0) {
            if (xray) {
              const o = pi * 4;
              data[o] = (data[o] * invAlpha + r * alpha) | 0;
              data[o + 1] = (data[o + 1] * invAlpha + g * alpha) | 0;
              data[o + 2] = (data[o + 2] * invAlpha + b * alpha) | 0;
            } else if (z < zbuf[pi]) {
              zbuf[pi] = z;
              const o = pi * 4;
              if (wire && (w0 < e0Thresh || w1 < e1Thresh || w2 < e2Thresh)) {
                data[o] = (r * 0.25 + wr * 0.75) | 0;
                data[o + 1] = (g * 0.25 + wg * 0.75) | 0;
                data[o + 2] = (b * 0.25 + wb * 0.75) | 0;
              } else {
                data[o] = r;
                data[o + 1] = g;
                data[o + 2] = b;
              }
            }
          }
        }
        w0 += a12;
        w1 += a20;
        w2 += a01;
      }

      w0Row += b12;
      w1Row += b20;
      w2Row += b01;
    }
  }

  _drawGridAndBed(vp, mesh, cam, state, modelValid) {
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
    const isYUp = cam.getUpAxis() === UpAxis.YUp;
    const groundElev = modelValid ? (isYUp ? mesh.bboxMin.y : mesh.bboxMin.z) - mr * 0.001 : 0.0;

    const drawSeg = (ax, ay, az, bx, by, bz, rgba, css) => {
      if (this.useZBuffer) {
        this._drawLine3DZBuf(vp, ax, ay, az, bx, by, bz, rgba[0], rgba[1], rgba[2], rgba[3]);
      } else {
        this._drawLine3DCtx(this.ctx, vp, ax, ay, az, bx, by, bz, css, this.dpr);
      }
    };

    if (state.showGrid) {
      const logS = Math.floor(Math.log10(Math.max(mr * 0.45, 0.05)));
      const step = Math.pow(10.0, logS);
      const count = 10;
      const halfSpan = count * step;

      const minorRgb = state.darkTheme ? [78, 92, 118, 0.38] : [90, 104, 126, 0.34];
      const majorRgb = state.darkTheme ? [112, 130, 162, 0.56] : [64, 76, 98, 0.52];
      const xRgb = state.darkTheme ? [216, 82, 82, 0.78] : [192, 48, 48, 0.76];
      const yRgb = isYUp
        ? (state.darkTheme ? [82, 146, 232, 0.78] : [44, 102, 196, 0.76])
        : (state.darkTheme ? [74, 192, 102, 0.78] : [42, 148, 62, 0.76]);

      const toCss = (c) => `rgba(${c[0]},${c[1]},${c[2]},${c[3]})`;

      if (!isYUp) {
        const cx = Math.round(gc.x / step) * step;
        const cy = Math.round(gc.y / step) * step;
        for (let i = -count; i <= count; i++) {
          const x = cx + i * step;
          const y = cy + i * step;
          const colX = Math.abs(y) < step * 0.01 ? xRgb : (Math.round(y / step) % 5 === 0 ? majorRgb : minorRgb);
          const colY = Math.abs(x) < step * 0.01 ? yRgb : (Math.round(x / step) % 5 === 0 ? majorRgb : minorRgb);
          drawSeg(cx - halfSpan, y, groundElev, cx + halfSpan, y, groundElev, colX, toCss(colX));
          drawSeg(x, cy - halfSpan, groundElev, x, cy + halfSpan, groundElev, colY, toCss(colY));
        }
      } else {
        const cx = Math.round(gc.x / step) * step;
        const cz = Math.round(gc.z / step) * step;
        for (let i = -count; i <= count; i++) {
          const x = cx + i * step;
          const z = cz + i * step;
          const colX = Math.abs(z) < step * 0.01 ? xRgb : (Math.round(z / step) % 5 === 0 ? majorRgb : minorRgb);
          const colZ = Math.abs(x) < step * 0.01 ? yRgb : (Math.round(x / step) % 5 === 0 ? majorRgb : minorRgb);
          drawSeg(cx - halfSpan, groundElev, z, cx + halfSpan, groundElev, z, colX, toCss(colX));
          drawSeg(x, groundElev, cz - halfSpan, x, groundElev, cz + halfSpan, colZ, toCss(colZ));
        }
      }
    }

    if (state.showBed && state.bedSize) {
      const bx = (state.bedSize.x || 220) * 0.5;
      const by = (state.bedSize.y || 220) * 0.5;
      const bedRgb = state.darkTheme ? [79, 156, 249, 0.85] : [37, 99, 235, 0.85];
      const bedCss = `rgba(${bedRgb[0]},${bedRgb[1]},${bedRgb[2]},${bedRgb[3]})`;
      if (!isYUp) {
        const cx = gc.x, cy = gc.y, gz = groundElev + mr * 0.0005;
        drawSeg(cx - bx, cy - by, gz, cx + bx, cy - by, gz, bedRgb, bedCss);
        drawSeg(cx + bx, cy - by, gz, cx + bx, cy + by, gz, bedRgb, bedCss);
        drawSeg(cx + bx, cy + by, gz, cx - bx, cy + by, gz, bedRgb, bedCss);
        drawSeg(cx - bx, cy + by, gz, cx - bx, cy - by, gz, bedRgb, bedCss);
      } else {
        const cx = gc.x, cz = gc.z, gy = groundElev + mr * 0.0005;
        drawSeg(cx - bx, gy, cz - by, cx + bx, gy, cz - by, bedRgb, bedCss);
        drawSeg(cx + bx, gy, cz - by, cx + bx, gy, cz + by, bedRgb, bedCss);
        drawSeg(cx + bx, gy, cz + by, cx - bx, gy, cz + by, bedRgb, bedCss);
        drawSeg(cx - bx, gy, cz + by, cx - bx, gy, cz - by, bedRgb, bedCss);
      }
    }
  }

  renderFrame(mesh, cam, state) {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    let cstats = {
      totalChunks: 0, frustumCulled: 0, coneCulled: 0,
      visibleChunks: 0, visibleTris: 0, drawCalls: 1,
    };

    const view = cam.viewMatrix();
    const proj = cam.projMatrix(w, h);
    const vp = Mat4.multiply(proj, view);
    const modelValid = this.hasMesh && mesh && mesh.ok && mesh.vertices;
    const isYUp = cam.getUpAxis() === UpAxis.YUp;

    if (this.useZBuffer) {
      this._allocBuffers();
      this._fillBackgroundZBuf(state.darkTheme);
    } else {
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      if (state.darkTheme) {
        grad.addColorStop(0, '#181c25');
        grad.addColorStop(1, '#0e1117');
      } else {
        grad.addColorStop(0, '#e6ebf2');
        grad.addColorStop(1, '#b8c2ce');
      }
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
      this._drawGridAndBed(vp, mesh, cam, state, modelValid);
    }

    if (modelValid) {
      const useCull = !state.twoSided && !state.sliceEnabled && !state.xray;
      const fr = Frustum.fromViewProj(vp);
      const { spans, stats } = cullChunks(mesh.chunks, fr, {
        backfaceConeCull: useCull,
        isOrtho: cam.isOrtho(),
        eye: cam.eye(),
        camForward: cam.forward(),
      });
      cstats = stats;

      const stride = this.targetSamples > 1 && this.accumCount === 0
        ? Math.max(2, Math.ceil(mesh.triCount / FAST_TRI_LIMIT))
        : 1;

      const verts = mesh.vertices;
      const bminX = mesh.bboxMin.x, bminY = mesh.bboxMin.y, bminZ = mesh.bboxMin.z;
      const sx = mesh.quantScale.x * INV_65535;
      const sy = mesh.quantScale.y * INV_65535;
      const sz = mesh.quantScale.z * INV_65535;
      const clipPlane = this._computeClipPlane(mesh, state);

      const mc = Math.max(0, Math.min(MatcapKind.Count - 1, state.matcap | 0));
      const lut = this.matcapTables[mc];

      const wr = state.darkTheme ? 68 : 18;
      const wg = state.darkTheme ? 156 : 54;
      const wb = state.darkTheme ? 248 : 118;

      const triList = this.triList;
      triList.length = 0;

      const emitTri = (x0, y0, z0, x1, y1, z1, x2, y2, z2) => {
        const e1x = x1 - x0, e1y = y1 - y0, e1z = z1 - z0;
        const e2x = x2 - x0, e2y = y2 - y0, e2z = z2 - z0;
        const wnx = e1y * e2z - e1z * e2y;
        const wny = e1z * e2x - e1x * e2z;
        const wnz = e1x * e2y - e1y * e2x;
        const wLen = Math.hypot(wnx, wny, wnz);

        let vnx = view[0] * wnx + view[4] * wny + view[8] * wnz;
        let vny = view[1] * wnx + view[5] * wny + view[9] * wnz;
        let vnz = view[2] * wnx + view[6] * wny + view[10] * wnz;
        const nLen = Math.hypot(vnx, vny, vnz);
        if (nLen > 1e-12) {
          const inv = 1.0 / nLen;
          vnx *= inv; vny *= inv; vnz *= inv;
        } else {
          vnx = 0; vny = 0; vnz = 1;
        }

        const backFace = vnz < 0;
        if (useCull && backFace) return;

        const p0 = this._projectPoint(vp, x0, y0, z0);
        const p1 = this._projectPoint(vp, x1, y1, z1);
        const p2 = this._projectPoint(vp, x2, y2, z2);
        if (!p0 || !p1 || !p2) return;

        if (Math.max(p0.sx, p1.sx, p2.sx) < 0 || Math.min(p0.sx, p1.sx, p2.sx) > w) return;
        if (Math.max(p0.sy, p1.sy, p2.sy) < 0 || Math.min(p0.sy, p1.sy, p2.sy) > h) return;
        if (Math.min(p0.z, p1.z, p2.z) > 1.0 || Math.max(p0.z, p1.z, p2.z) < -1.0) return;

        if (backFace) {
          vnx = -vnx; vny = -vny; vnz = -vnz;
        }

        let r, g, b, a = 1.0;
        const upDot = wLen > 1e-12 ? (isYUp ? wny / wLen : wnz / wLen) : 0;
        const isOverhang = state.overhang && !backFace && upDot < OVERHANG_COS;

        if (state.xray) {
          const rim = Math.pow(Math.max(0, Math.min(1, 1.0 - Math.abs(vnz))), 1.85);
          const br = state.darkTheme ? 41 : 10;
          const bg = state.darkTheme ? 143 : 61;
          const bb = state.darkTheme ? 245 : 138;
          const mult = 0.28 + 1.35 * rim;
          r = Math.min(255, Math.round(br * mult));
          g = Math.min(255, Math.round(bg * mult));
          b = Math.min(255, Math.round(bb * mult));
          a = Math.max(0.14, Math.min(0.88, 0.14 + 0.72 * rim));
        } else {
          const tx = Math.max(0, Math.min(MATCAP_SIZE - 1, Math.round((vnx * 0.492 + 0.5) * (MATCAP_SIZE - 1))));
          const ty = Math.max(0, Math.min(MATCAP_SIZE - 1, Math.round((0.5 - vny * 0.492) * (MATCAP_SIZE - 1))));
          const idx = (ty * MATCAP_SIZE + tx) * 4;
          r = lut[idx];
          g = lut[idx + 1];
          b = lut[idx + 2];
          if (backFace) {
            const bt = 0.45 + 0.65 * Math.max(0, Math.min(1, vnz));
            r = Math.round(r * 0.24 + 140 * bt * 0.68);
            g = Math.round(g * 0.24 + 56 * bt * 0.68);
            b = Math.round(b * 0.24 + 36 * bt * 0.68);
          } else if (isOverhang) {
            const shade = 0.42 + 0.58 * Math.max(0, Math.min(1, vnz));
            r = Math.min(255, Math.round(r * 0.25 + 242 * shade * 0.80));
            g = Math.min(255, Math.round(g * 0.25 + 78 * shade * 0.75));
            b = Math.min(255, Math.round(b * 0.25 + 58 * shade * 0.75));
          }
        }

        if (this.useZBuffer) {
          this._rasterizeTriZBuf(p0, p1, p2, r, g, b, a, !!state.wireframe, wr, wg, wb, !!state.xray);
        } else {
          const avgZ = (p0.z + p1.z + p2.z) * 0.3333333;
          triList.push({
            x0: p0.sx, y0: p0.sy, x1: p1.sx, y1: p1.sy, x2: p2.sx, y2: p2.sy,
            z: avgZ,
            fill: a < 0.99 ? `rgba(${r},${g},${b},${a.toFixed(2)})` : `rgb(${r},${g},${b})`,
          });
        }
      };

      for (let s = 0; s < spans.length; s++) {
        const sp = spans[s];
        const vEnd = sp.firstVert + sp.vertCount;
        for (let vi = sp.firstVert; vi < vEnd; vi += 3 * stride) {
          const i0 = vi * 4;
          const x0 = bminX + verts[i0] * sx, y0 = bminY + verts[i0 + 1] * sy, z0 = bminZ + verts[i0 + 2] * sz;
          const x1 = bminX + verts[i0 + 4] * sx, y1 = bminY + verts[i0 + 5] * sy, z1 = bminZ + verts[i0 + 6] * sz;
          const x2 = bminX + verts[i0 + 8] * sx, y2 = bminY + verts[i0 + 9] * sy, z2 = bminZ + verts[i0 + 10] * sz;

          if (state.sliceEnabled) {
            const d0 = x0 * clipPlane[0] + y0 * clipPlane[1] + z0 * clipPlane[2] + clipPlane[3];
            const d1 = x1 * clipPlane[0] + y1 * clipPlane[1] + z1 * clipPlane[2] + clipPlane[3];
            const d2 = x2 * clipPlane[0] + y2 * clipPlane[1] + z2 * clipPlane[2] + clipPlane[3];
            if (d0 < 0 && d1 < 0 && d2 < 0) continue;
            if (d0 >= 0 && d1 >= 0 && d2 >= 0) {
              emitTri(x0, y0, z0, x1, y1, z1, x2, y2, z2);
            } else {
              const clipped = clipPolygonPlane(
                [{ x: x0, y: y0, z: z0 }, { x: x1, y: y1, z: z1 }, { x: x2, y: y2, z: z2 }],
                clipPlane
              );
              for (let k = 1; k + 1 < clipped.length; k++) {
                emitTri(
                  clipped[0].x, clipped[0].y, clipped[0].z,
                  clipped[k].x, clipped[k].y, clipped[k].z,
                  clipped[k + 1].x, clipped[k + 1].y, clipped[k + 1].z
                );
              }
            }
          } else {
            emitTri(x0, y0, z0, x1, y1, z1, x2, y2, z2);
          }
        }
      }

      if (!this.useZBuffer) {
        triList.sort((a, b) => b.z - a.z);
        const wireStroke = state.wireframe
          ? (state.darkTheme ? 'rgba(62,148,245,0.65)' : 'rgba(13,46,102,0.65)')
          : null;
        ctx.lineWidth = Math.max(0.8, 0.9 * this.dpr);
        ctx.lineJoin = 'round';
        for (let i = 0; i < triList.length; i++) {
          const t = triList[i];
          ctx.beginPath();
          ctx.moveTo(t.x0, t.y0);
          ctx.lineTo(t.x1, t.y1);
          ctx.lineTo(t.x2, t.y2);
          ctx.closePath();
          ctx.fillStyle = t.fill;
          ctx.fill();
          if (wireStroke) {
            ctx.strokeStyle = wireStroke;
            ctx.stroke();
          }
        }
      }
    }

    if (this.useZBuffer) {
      // Depth-occluded grid & build plate drawn right into the Z-buffer
      this._drawGridAndBed(vp, mesh, cam, state, modelValid);
      ctx.putImageData(this.imgData, 0, 0);
    }

    // Measurement pins & line (vector overlay)
    if (state.measureHasA) {
      const rPin = Math.max(cam.distance() * 0.012, 0.1);
      const drawDia = (p) => {
        const pts = [
          [p.x + rPin, p.y, p.z], [p.x - rPin, p.y, p.z],
          [p.x, p.y + rPin, p.z], [p.x, p.y - rPin, p.z],
          [p.x, p.y, p.z + rPin], [p.x, p.y, p.z - rPin],
        ];
        const pairs = [[0, 2], [2, 1], [1, 3], [3, 0], [0, 4], [4, 1], [1, 5], [5, 0], [2, 4], [4, 3], [3, 5], [5, 2]];
        for (let i = 0; i < pairs.length; i++) {
          const a = pts[pairs[i][0]], b = pts[pairs[i][1]];
          this._drawLine3DCtx(ctx, vp, a[0], a[1], a[2], b[0], b[1], b[2], '#fa9e26', 1.7 * this.dpr);
        }
      };
      drawDia(state.measureA);
      if (state.measureHasB) {
        drawDia(state.measureB);
        this._drawLine3DCtx(
          ctx, vp,
          state.measureA.x, state.measureA.y, state.measureA.z,
          state.measureB.x, state.measureB.y, state.measureB.z,
          '#59c7ff', 2.0 * this.dpr
        );
      }
    }

    // Dynamic 3D Axis Triad (synced with #triad-btn CSS rect)
    let axisTipsCss = null;
    if (state.showHud) {
      const cssW = w / this.dpr;
      const cssH = h / this.dpr;
      const cxCss = state.triadCenterCss ? state.triadCenterCss.x : cssW - 54.0;
      const cyCss = state.triadCenterCss ? state.triadCenterCss.y : cssH - 54.0;
      const armCss = 22.0;
      const labelArmCss = 33.0;
      const dirs = [
        [view[0], view[1], view[2]],
        [view[4], view[5], view[6]],
        [view[8], view[9], view[10]],
      ];
      const cols = state.darkTheme
        ? ['#f55c52', '#57e06b', '#5ca3fa']
        : ['#d12e29', '#249933', '#1f66d6'];

      axisTipsCss = new Array(3);
      ctx.lineWidth = Math.max(1.4, 1.6 * this.dpr);
      for (let i = 0; i < 3; i++) {
        const sxCss = cxCss + dirs[i][0] * armCss;
        const syCss = cyCss - dirs[i][1] * armCss;
        axisTipsCss[i] = {
          x: cxCss + dirs[i][0] * labelArmCss,
          y: cyCss - dirs[i][1] * labelArmCss,
        };
        ctx.strokeStyle = cols[i];
        ctx.beginPath();
        ctx.moveTo(cxCss * this.dpr, cyCss * this.dpr);
        ctx.lineTo(sxCss * this.dpr, syCss * this.dpr);
        ctx.stroke();
      }
    }

    this.accumCount = Math.min(this.targetSamples, this.accumCount + 1);
    return { cstats, axisTipsCss, accumCount: this.accumCount };
  }

  pickWorldPoint(cssX, cssY, cam, mesh, state) {
    return pickMeshCpu(cssX, cssY, this.width, this.height, this.dpr, cam, mesh, state);
  }
}
