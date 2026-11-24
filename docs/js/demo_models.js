export const DEMO_MODELS = Object.freeze([
  { id: 'flange-housing', name: 'flange-housing.stl', label: 'Flange Housing' },
  { id: 'spur-gear', name: 'spur-gear.stl', label: 'Spur Gear (18T)' },
  { id: 'calibration-block', name: 'calibration-block.stl', label: 'Calibration Block' },
]);

export function buildBinaryStl(triangles, headerLabel = 'stlviewer procedural CAD') {
  const triCount = (triangles.length / 9) | 0;
  const buf = new ArrayBuffer(84 + triCount * 50);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < Math.min(headerLabel.length, 79); i++) {
    bytes[i] = headerLabel.charCodeAt(i) & 0x7f;
  }
  const dv = new DataView(buf);
  dv.setUint32(80, triCount, true);

  for (let t = 0; t < triCount; t++) {
    const b = t * 9;
    const x0 = triangles[b], y0 = triangles[b + 1], z0 = triangles[b + 2];
    const x1 = triangles[b + 3], y1 = triangles[b + 4], z1 = triangles[b + 5];
    const x2 = triangles[b + 6], y2 = triangles[b + 7], z2 = triangles[b + 8];
    const e1x = x1 - x0, e1y = y1 - y0, e1z = z1 - z0;
    const e2x = x2 - x0, e2y = y2 - y0, e2z = z2 - z0;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const l = Math.hypot(nx, ny, nz);
    if (l > 1e-12) { nx /= l; ny /= l; nz /= l; }

    const off = 84 + t * 50;
    dv.setFloat32(off + 0, nx, true);
    dv.setFloat32(off + 4, ny, true);
    dv.setFloat32(off + 8, nz, true);
    dv.setFloat32(off + 12, x0, true);
    dv.setFloat32(off + 16, y0, true);
    dv.setFloat32(off + 20, z0, true);
    dv.setFloat32(off + 24, x1, true);
    dv.setFloat32(off + 28, y1, true);
    dv.setFloat32(off + 32, z1, true);
    dv.setFloat32(off + 36, x2, true);
    dv.setFloat32(off + 40, y2, true);
    dv.setFloat32(off + 44, z2, true);
    dv.setUint16(off + 48, 0, true);
  }
  return buf;
}

function pushTri(out, ax, ay, az, bx, by, bz, cx, cy, cz) {
  out.push(ax, ay, az, bx, by, bz, cx, cy, cz);
}

function pushQuad(out, ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz) {
  pushTri(out, ax, ay, az, bx, by, bz, cx, cy, cz);
  pushTri(out, ax, ay, az, cx, cy, cz, dx, dy, dz);
}

// Revolved profile segment stack around Z axis (closed watertight tube/ring)
// profile: array of [rOuter, rInner, z] or stepped cylinder with hole
function addWasherStack(out, segs, rings, cx = 0, cy = 0) {
  // rings: [{ z, rOut, rIn }] from bottom to top; closes bottom & top caps cleanly.
  // Actually easier: closed solid-of-revolution defined by closed 2D loop in (r, z) plane!
  const n = rings.length;
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    const c0 = Math.cos(a0), s0 = Math.sin(a0);
    const c1 = Math.cos(a1), s1 = Math.sin(a1);

    for (let j = 0; j < n; j++) {
      const [rA, zA] = rings[j];
      const [rB, zB] = rings[(j + 1) % n];
      if (Math.hypot(rB - rA, zB - zA) < 1e-7) continue;

      if (rA < 1e-6 && rB >= 1e-6) {
        pushTri(
          out,
          cx, cy, zA,
          cx + rB * c1, cy + rB * s1, zB,
          cx + rB * c0, cy + rB * s0, zB
        );
      } else if (rB < 1e-6 && rA >= 1e-6) {
        pushTri(
          out,
          cx + rA * c0, cy + rA * s0, zA,
          cx + rA * c1, cy + rA * s1, zA,
          cx, cy, zB
        );
      } else if (rA >= 1e-6 && rB >= 1e-6) {
        pushQuad(
          out,
          cx + rA * c0, cy + rA * s0, zA,
          cx + rA * c1, cy + rA * s1, zA,
          cx + rB * c1, cy + rB * s1, zB,
          cx + rB * c0, cy + rB * s0, zB
        );
      }
    }
  }
}

function addBox(out, x0, y0, z0, x1, y1, z1) {
  // -Z bottom
  pushQuad(out, x0, y0, z0, x0, y1, z0, x1, y1, z0, x1, y0, z0);
  // +Z top
  pushQuad(out, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1);
  // -Y front
  pushQuad(out, x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1);
  // +Y back
  pushQuad(out, x1, y1, z0, x0, y1, z0, x0, y1, z1, x1, y1, z1);
  // -X left
  pushQuad(out, x0, y1, z0, x0, y0, z0, x0, y0, z1, x0, y1, z1);
  // +X right
  pushQuad(out, x1, y0, z0, x1, y1, z0, x1, y1, z1, x1, y0, z1);
}

// Extrude a closed 2D polygon ring (outer CCW, optional inner CW) between z0 and z1
function addExtrudedRing(out, outerPts, innerPts, z0, z1) {
  const n = outerPts.length;
  // Assume convex or star-shaped around origin if innerPts provided with matching count or ear-clipping-free fan
  if (innerPts && innerPts.length === n) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const [ox0, oy0] = outerPts[i];
      const [ox1, oy1] = outerPts[j];
      const [ix0, iy0] = innerPts[i];
      const [ix1, iy1] = innerPts[j];
      // Outer wall
      pushQuad(out, ox0, oy0, z0, ox1, oy1, z0, ox1, oy1, z1, ox0, oy0, z1);
      // Inner wall (facing inward)
      pushQuad(out, ix1, iy1, z0, ix0, iy0, z0, ix0, iy0, z1, ix1, iy1, z1);
      // Top cap
      pushQuad(out, ix0, iy0, z1, ox0, oy0, z1, ox1, oy1, z1, ix1, iy1, z1);
      // Bottom cap
      pushQuad(out, ox0, oy0, z0, ix0, iy0, z0, ix1, iy1, z0, ox1, oy1, z0);
    }
  }
}

function makeFlangeHousing() {
  const out = [];
  // Main flanged bearing housing with chamfered bore, shoulder, and 6 peripheral bolt lugs
  // Revolution profile CCW in (r, z) cross-section -> outward normals
  const profile = [
    [14.0, 0.0],
    [42.0, 0.0],
    [44.0, 2.0],
    [44.0, 9.0],
    [42.0, 11.0],
    [27.0, 11.0],
    [24.0, 14.0],
    [24.0, 28.0],
    [22.0, 30.0],
    [16.0, 30.0],
    [14.0, 28.0],
    [14.0, 18.0],
    [12.0, 16.0],
    [12.0, 2.0],
  ];
  addWasherStack(out, 64, profile, 0, 0);

  // 6 machined bolt bosses / socket caps around R=34mm (embedded 0.25mm into flange to avoid coplanar Z-fighting on slice)
  const bossProfile = [
    [2.8, 10.75],
    [6.2, 10.75],
    [6.2, 14.2],
    [5.4, 15.0],
    [3.2, 15.0],
    [2.8, 14.4],
  ];
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    addWasherStack(out, 24, bossProfile, Math.cos(a) * 34.0, Math.sin(a) * 34.0);
  }

  // 6 reinforcing radial ribs between hub (r=23.5) and flange (r=40)
  for (let k = 0; k < 6; k++) {
    const a = ((k + 0.5) / 6) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    const nx = -sa, ny = ca;
    const hw = 2.0;
    const r0 = 23.0, r1 = 38.0;
    const z0 = 10.5, z1t = 22.0, z1b = 12.0;

    const p00 = [r0 * ca - hw * nx, r0 * sa - hw * ny];
    const p01 = [r0 * ca + hw * nx, r0 * sa + hw * ny];
    const p10 = [r1 * ca - hw * nx, r1 * sa - hw * ny];
    const p11 = [r1 * ca + hw * nx, r1 * sa + hw * ny];

    // Bottom
    pushQuad(out, p00[0], p00[1], z0, p01[0], p01[1], z0, p11[0], p11[1], z0, p10[0], p10[1], z0);
    // Sloped top
    pushQuad(out, p00[0], p00[1], z1t, p10[0], p10[1], z1b, p11[0], p11[1], z1b, p01[0], p01[1], z1t);
    // Inner face
    pushQuad(out, p01[0], p01[1], z0, p00[0], p00[1], z0, p00[0], p00[1], z1t, p01[0], p01[1], z1t);
    // Outer face
    pushQuad(out, p10[0], p10[1], z0, p11[0], p11[1], z0, p11[0], p11[1], z1b, p10[0], p10[1], z1b);
    // Side walls
    pushQuad(out, p00[0], p00[1], z0, p10[0], p10[1], z0, p10[0], p10[1], z1b, p00[0], p00[1], z1t);
    pushQuad(out, p11[0], p11[1], z0, p01[0], p01[1], z0, p01[0], p01[1], z1t, p11[0], p11[1], z1b);
  }

  return buildBinaryStl(out, 'stlviewer flange-housing.stl');
}

function makeSpurGear() {
  const out = [];
  const teeth = 18;
  const subPerTooth = 8;
  const totalPts = teeth * subPerTooth;
  const rRoot = 28.0;
  const rPitch = 32.0;
  const rTip = 36.2;
  const rBore = 10.0;

  const outer = [];
  const inner = [];
  for (let i = 0; i < totalPts; i++) {
    const a = (i / totalPts) * Math.PI * 2;
    const phase = (i % subPerTooth) / subPerTooth;
    let r = rRoot;
    if (phase >= 0.15 && phase < 0.30) {
      const t = (phase - 0.15) / 0.15;
      r = rRoot + (rTip - rRoot) * (0.5 - 0.5 * Math.cos(t * Math.PI));
    } else if (phase >= 0.30 && phase < 0.50) {
      r = rTip;
    } else if (phase >= 0.50 && phase < 0.65) {
      const t = (phase - 0.50) / 0.15;
      r = rTip - (rTip - rRoot) * (0.5 - 0.5 * Math.cos(t * Math.PI));
    }
    outer.push([Math.cos(a) * r, Math.sin(a) * r]);
    inner.push([Math.cos(a) * (rPitch - 8.5), Math.sin(a) * (rPitch - 8.5)]);
  }

  // Gear rim with teeth
  addExtrudedRing(out, outer, inner, 0.0, 12.0);

  // Recessed web + central hub with bore
  const hubProfile = [
    [rBore, -3.0],
    [16.0, -3.0],
    [17.5, -1.5],
    [17.5, 2.5],
    [24.5, 2.5],
    [24.5, 9.5],
    [17.5, 9.5],
    [17.5, 13.5],
    [16.0, 15.0],
    [rBore, 15.0],
  ];
  addWasherStack(out, 48, hubProfile, 0, 0);

  return buildBinaryStl(out, 'stlviewer spur-gear.stl');
}

function makeCalibrationBlock() {
  const out = [];
  // Stepped metrology gauge block + chamfered top tower
  // Slight 0.2mm overlap into supporting base avoids coplanar opposite-normal Z-fighting during cross-section slicing
  addBox(out, -30, -20, 0, 30, 20, 10);
  addBox(out, -24, -14, 9.8, 8, 14, 22);
  addBox(out, -20, -10, 21.8, 4, 10, 30);

  // Precision calibration cylinder with bore on right platform
  const cyl = [
    [4.5, 9.8],
    [10.0, 9.8],
    [10.0, 26.0],
    [8.8, 27.5],
    [5.5, 27.5],
    [4.5, 26.5],
  ];
  addWasherStack(out, 48, cyl, 18.0, 0.0);

  return buildBinaryStl(out, 'stlviewer calibration-block.stl');
}

export function generateDemoStl(id) {
  switch (id) {
    case 'spur-gear':
      return makeSpurGear();
    case 'calibration-block':
      return makeCalibrationBlock();
    case 'flange-housing':
    default:
      return makeFlangeHousing();
  }
}
