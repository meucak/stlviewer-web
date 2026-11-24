import {
  PI,
  DEG2RAD,
  Mat4,
  vAdd,
  vSub,
  vNeg,
  vScale,
  vDot,
  vCross,
  vLen,
  vNorm,
  vLerp,
} from './math3d.js';

export const ViewPreset = Object.freeze({
  Iso: 'iso',
  Front: 'front',
  Back: 'back',
  Right: 'right',
  Left: 'left',
  Top: 'top',
  Bottom: 'bottom',
});

export const UpAxis = Object.freeze({
  ZUp: 'zup',
  YUp: 'yup',
});

const MAX_PITCH = 1.565;
const MIN_FOV_SIN = 0.1;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function wrapAngleDiff(from, to) {
  let d = (to - from) % (2.0 * PI);
  if (d > PI) d -= 2.0 * PI;
  if (d < -PI) d += 2.0 * PI;
  return d;
}

export class Camera {
  constructor() {
    this.cur = { target: { x: 0, y: 0, z: 0 }, yaw: -PI * 0.25, pitch: 0.6154797, distance: 100.0 };
    this.dst = { target: { x: 0, y: 0, z: 0 }, yaw: -PI * 0.25, pitch: 0.6154797, distance: 100.0 };
    this.animActive = false;
    this.ortho = false;
    this.upAxis = UpAxis.ZUp;
    this.fovDeg = 40.0;
    this.sceneRadius = 50.0;
    this.setPreset(ViewPreset.Iso, false);
  }

  _worldUpVec() {
    return this.upAxis === UpAxis.ZUp ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
  }

  _dirFromAngles(yaw, pitch) {
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    if (this.upAxis === UpAxis.ZUp) {
      return { x: cp * Math.cos(yaw), y: cp * Math.sin(yaw), z: sp };
    }
    return { x: cp * Math.sin(yaw), y: sp, z: cp * Math.cos(yaw) };
  }

  _clampState(s) {
    s.pitch = clamp(s.pitch, -MAX_PITCH, MAX_PITCH);
    const minDist = Math.max(this.sceneRadius * 0.01, 1e-3);
    const maxDist = Math.max(this.sceneRadius * 200.0, 1000.0);
    s.distance = clamp(s.distance, minDist, maxDist);
  }

  frameBounds(bmin, bmax, vpW, vpH, animate = false) {
    const center = vScale(vAdd(bmin, bmax), 0.5);
    const extent = vSub(bmax, bmin);
    const radius = Math.max(vLen(extent) * 0.5, 1e-2);
    this.sceneRadius = radius;

    const aspect = vpW > 0 && vpH > 0 ? vpW / vpH : 1.777;
    const halfFovY = this.fovDeg * 0.5 * DEG2RAD;
    const halfFovX = Math.atan(Math.tan(halfFovY) * aspect);
    const minHalfFov = Math.min(halfFovY, halfFovX);
    const sinF = Math.max(Math.sin(minHalfFov), MIN_FOV_SIN);

    this.dst.target = { ...center };
    this.dst.distance = (radius / sinF) * 1.12;
    this._clampState(this.dst);

    if (!animate) {
      this.cur = { ...this.dst, target: { ...this.dst.target } };
      this.animActive = false;
    } else {
      this.animActive = true;
    }
  }

  setPreset(preset, animate = true) {
    let yaw = -PI * 0.25;
    let pitch = 0.6154797;

    if (this.upAxis === UpAxis.ZUp) {
      switch (preset) {
        case ViewPreset.Iso:    yaw = -PI * 0.25; pitch = 0.6154797; break;
        case ViewPreset.Front:  yaw = -PI * 0.50; pitch = 0.0;       break;
        case ViewPreset.Back:   yaw =  PI * 0.50; pitch = 0.0;       break;
        case ViewPreset.Right:  yaw =  0.0;       pitch = 0.0;       break;
        case ViewPreset.Left:   yaw =  PI;        pitch = 0.0;       break;
        case ViewPreset.Top:    yaw = -PI * 0.50; pitch =  MAX_PITCH; break;
        case ViewPreset.Bottom: yaw = -PI * 0.50; pitch = -MAX_PITCH; break;
      }
    } else {
      switch (preset) {
        case ViewPreset.Iso:    yaw =  PI * 0.25; pitch = 0.6154797; break;
        case ViewPreset.Front:  yaw =  0.0;       pitch = 0.0;       break;
        case ViewPreset.Back:   yaw =  PI;        pitch = 0.0;       break;
        case ViewPreset.Right:  yaw =  PI * 0.50; pitch = 0.0;       break;
        case ViewPreset.Left:   yaw = -PI * 0.50; pitch = 0.0;       break;
        case ViewPreset.Top:    yaw =  0.0;       pitch =  MAX_PITCH; break;
        case ViewPreset.Bottom: yaw =  0.0;       pitch = -MAX_PITCH; break;
      }
    }

    this.dst.yaw = this.cur.yaw + wrapAngleDiff(this.cur.yaw, yaw);
    this.dst.pitch = pitch;
    this._clampState(this.dst);

    if (!animate) {
      this.cur.yaw = yaw;
      this.cur.pitch = this.dst.pitch;
      this.dst.yaw = yaw;
      this.animActive = false;
    } else {
      this.animActive = true;
    }
  }

  orbit(dxPixels, dyPixels, vpW, vpH) {
    const scale = (2.0 * PI) / Math.max(Math.min(vpW, vpH), 200);
    this.cur.yaw -= dxPixels * scale;
    this.cur.pitch += dyPixels * scale;
    this._clampState(this.cur);
    this.dst = { ...this.cur, target: { ...this.cur.target } };
    this.animActive = false;
  }

  pan(dxPixels, dyPixels, vpW, vpH) {
    if (vpH <= 0) return;
    const halfH = this.cur.distance * Math.tan(this.fovDeg * 0.5 * DEG2RAD);
    const worldPerPx = (2.0 * halfH) / vpH;
    const shift = vScale(
      vAdd(vScale(this.right(), -dxPixels), vScale(this.up(), dyPixels)),
      worldPerPx
    );
    this.cur.target = vAdd(this.cur.target, shift);
    this.dst = { ...this.cur, target: { ...this.cur.target } };
    this.animActive = false;
  }

  zoom(wheelSteps, mouseXPx, mouseYPx, vpW, vpH) {
    if (Math.abs(wheelSteps) < 1e-5) return;

    const rayPlaneHit = (mx, my) => {
      if (vpW <= 0 || vpH <= 0) return null;
      const invVp = Mat4.inverse(this.viewProj(vpW, vpH));
      if (!invVp) return null;
      const glY = vpH - 1.0 - my;
      const p0 = Mat4.unproject({ x: mx, y: glY, z: 0.0 }, invVp, vpW, vpH);
      const p1 = Mat4.unproject({ x: mx, y: glY, z: 1.0 }, invVp, vpW, vpH);
      if (!p0 || !p1) return null;
      const rayDir = vNorm(vSub(p1, p0));
      const n = this.forward();
      const denom = vDot(rayDir, n);
      if (Math.abs(denom) < 1e-6) return null;
      const t = vDot(vSub(this.cur.target, p0), n) / denom;
      return vAdd(p0, vScale(rayDir, t));
    };

    let before = null;
    if (mouseXPx >= 0 && mouseYPx >= 0 && vpW > 0 && vpH > 0) {
      before = rayPlaneHit(mouseXPx, mouseYPx);
    }

    const factor = Math.pow(0.86, wheelSteps);
    this.cur.distance *= factor;
    this._clampState(this.cur);

    if (before) {
      const after = rayPlaneHit(mouseXPx, mouseYPx);
      if (after) {
        this.cur.target = vAdd(this.cur.target, vSub(before, after));
      }
    }

    this.dst = { ...this.cur, target: { ...this.cur.target } };
    this.animActive = false;
  }

  setOrtho(enable) {
    this.ortho = !!enable;
  }

  toggleOrtho() {
    this.setOrtho(!this.ortho);
  }

  setUpAxis(axis) {
    if (this.upAxis === axis) return;
    this.upAxis = axis;
    this.setPreset(ViewPreset.Iso, false);
  }

  toggleUpAxis() {
    this.setUpAxis(this.upAxis === UpAxis.ZUp ? UpAxis.YUp : UpAxis.ZUp);
  }

  setPivot(worldPivot, animate = true) {
    this.dst.target = { ...worldPivot };
    if (!animate) {
      this.cur.target = { ...worldPivot };
      this.animActive = false;
    } else {
      this.animActive = true;
    }
  }

  setSceneRadius(r) {
    this.sceneRadius = Math.max(r, 1e-3);
  }

  step(dt) {
    if (!this.animActive) return false;
    const alpha = 1.0 - Math.exp(-14.0 * clamp(dt, 0.0, 0.1));
    this.cur.target = vLerp(this.cur.target, this.dst.target, alpha);
    this.cur.yaw += (this.dst.yaw - this.cur.yaw) * alpha;
    this.cur.pitch += (this.dst.pitch - this.cur.pitch) * alpha;
    this.cur.distance += (this.dst.distance - this.cur.distance) * alpha;

    const errT = vLen(vSub(this.dst.target, this.cur.target));
    const errA = Math.abs(this.dst.yaw - this.cur.yaw) + Math.abs(this.dst.pitch - this.cur.pitch);
    const errD = Math.abs(this.dst.distance - this.cur.distance) / Math.max(this.dst.distance, 1e-4);
    if (errT < this.sceneRadius * 1e-4 && errA < 5e-4 && errD < 5e-4) {
      this.snap();
      return false;
    }
    return true;
  }

  snap() {
    this.cur = { ...this.dst, target: { ...this.dst.target } };
    this.animActive = false;
  }

  isAnimating() { return this.animActive; }
  isOrtho() { return this.ortho; }
  getUpAxis() { return this.upAxis; }
  target() { return this.cur.target; }
  distance() { return this.cur.distance; }

  getState() {
    return {
      yaw: this.cur.yaw,
      pitch: this.cur.pitch,
      distance: this.cur.distance,
      target: { ...this.cur.target },
      ortho: this.ortho,
      upAxis: this.upAxis,
    };
  }

  applyState(s) {
    if (!s) return;
    if (s.upAxis === UpAxis.YUp || s.upAxis === UpAxis.ZUp) {
      this.upAxis = s.upAxis;
    }
    this.ortho = !!s.ortho;
    if (Number.isFinite(s.yaw)) this.cur.yaw = s.yaw;
    if (Number.isFinite(s.pitch)) this.cur.pitch = s.pitch;
    if (Number.isFinite(s.distance)) this.cur.distance = s.distance;
    if (s.target && Number.isFinite(s.target.x)) {
      this.cur.target = { x: s.target.x, y: s.target.y, z: s.target.z };
    }
    this._clampState(this.cur);
    this.dst = { ...this.cur, target: { ...this.cur.target } };
    this.animActive = false;
  }

  eye() {
    return vAdd(this.cur.target, vScale(this._dirFromAngles(this.cur.yaw, this.cur.pitch), this.cur.distance));
  }

  forward() {
    return vNeg(this._dirFromAngles(this.cur.yaw, this.cur.pitch));
  }

  right() {
    return vNorm(vCross(this.forward(), this._worldUpVec()));
  }

  up() {
    return vCross(this.right(), this.forward());
  }

  computeNearFar() {
    const r = Math.max(this.sceneRadius, 1e-3);
    const dist = this.cur.distance;
    if (this.ortho) {
      const span = Math.max(dist + r * 4.0, r * 10.0);
      return { zNear: -span, zFar: span };
    }
    const zFar = Math.max(dist + r * 4.0, r * 10.0);
    const minNear = Math.max(zFar / 8000.0, Math.min(dist * 0.01, r * 0.002));
    const tightNear = dist - r * 1.25;
    return { zNear: Math.max(minNear, tightNear), zFar };
  }

  viewMatrix() {
    return Mat4.lookAt(this.eye(), this.cur.target, this._worldUpVec());
  }

  projMatrix(vpW, vpH, jitterNdcX = 0.0, jitterNdcY = 0.0) {
    const aspect = vpW > 0 && vpH > 0 ? vpW / vpH : 1.777;
    const { zNear, zFar } = this.computeNearFar();
    if (this.ortho) {
      const halfH = this.cur.distance * Math.tan(this.fovDeg * 0.5 * DEG2RAD);
      const halfW = halfH * aspect;
      const p = Mat4.ortho(-halfW, halfW, -halfH, halfH, zNear, zFar);
      p[12] += jitterNdcX;
      p[13] += jitterNdcY;
      return p;
    }
    const p = Mat4.perspective(this.fovDeg * DEG2RAD, aspect, zNear, zFar);
    p[8] -= jitterNdcX;
    p[9] -= jitterNdcY;
    return p;
  }

  viewProj(vpW, vpH, jitterNdcX = 0.0, jitterNdcY = 0.0) {
    return Mat4.multiply(this.projMatrix(vpW, vpH, jitterNdcX, jitterNdcY), this.viewMatrix());
  }
}
