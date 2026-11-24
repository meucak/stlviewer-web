export const CHUNK_TRIS = 4096;

const INV_65535 = 1.0 / 65535.0;

function isFiniteTri(x0, y0, z0, x1, y1, z1, x2, y2, z2) {
  return (
    Number.isFinite(x0) && Number.isFinite(y0) && Number.isFinite(z0) &&
    Number.isFinite(x1) && Number.isFinite(y1) && Number.isFinite(z1) &&
    Number.isFinite(x2) && Number.isFinite(y2) && Number.isFinite(z2)
  );
}

function quantizeCoord(val, minVal, invScale) {
  let t = (val - minVal) * invScale;
  if (t < 0.0) t = 0.0;
  else if (t > 1.0) t = 1.0;
  return (t * 65535.0 + 0.5) | 0;
}

function createPass1Stats() {
  return {
    minX: Infinity, minY: Infinity, minZ: Infinity,
    maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity,
    volume6: 0.0,
    area2: 0.0,
    degenerateTris: 0,
    hasValid: false,
  };
}

function accumulateTriStats(x0, y0, z0, x1, y1, z1, x2, y2, z2, st) {
  if (!isFiniteTri(x0, y0, z0, x1, y1, z1, x2, y2, z2)) {
    st.degenerateTris++;
    return;
  }
  st.hasValid = true;
  if (x0 < st.minX) st.minX = x0; if (x1 < st.minX) st.minX = x1; if (x2 < st.minX) st.minX = x2;
  if (y0 < st.minY) st.minY = y0; if (y1 < st.minY) st.minY = y1; if (y2 < st.minY) st.minY = y2;
  if (z0 < st.minZ) st.minZ = z0; if (z1 < st.minZ) st.minZ = z1; if (z2 < st.minZ) st.minZ = z2;

  if (x0 > st.maxX) st.maxX = x0; if (x1 > st.maxX) st.maxX = x1; if (x2 > st.maxX) st.maxX = x2;
  if (y0 > st.maxY) st.maxY = y0; if (y1 > st.maxY) st.maxY = y1; if (y2 > st.maxY) st.maxY = y2;
  if (z0 > st.maxZ) st.maxZ = z0; if (z1 > st.maxZ) st.maxZ = z1; if (z2 > st.maxZ) st.maxZ = z2;

  const c12x = y1 * z2 - z1 * y2;
  const c12y = z1 * x2 - x1 * z2;
  const c12z = x1 * y2 - y1 * x2;
  st.volume6 += x0 * c12x + y0 * c12y + z0 * c12z;

  const e1x = x1 - x0, e1y = y1 - y0, e1z = z1 - z0;
  const e2x = x2 - x0, e2y = y2 - y0, e2z = z2 - z0;
  const nx = e1y * e2z - e1z * e2y;
  const ny = e1z * e2x - e1x * e2z;
  const nz = e1x * e2y - e1y * e2x;
  const a2 = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (a2 <= 1e-12) st.degenerateTris++;
  st.area2 += a2;
}

function finalizeChunksAndQuantize(triCount, readTriFn, st) {
  const bboxMin = { x: st.minX, y: st.minY, z: st.minZ };
  const bboxMax = { x: st.maxX, y: st.maxY, z: st.maxZ };
  const bboxExtent = {
    x: st.maxX - st.minX,
    y: st.maxY - st.minY,
    z: st.maxZ - st.minZ,
  };
  const quantScale = {
    x: bboxExtent.x > 1e-12 ? bboxExtent.x : 0.0,
    y: bboxExtent.y > 1e-12 ? bboxExtent.y : 0.0,
    z: bboxExtent.z > 1e-12 ? bboxExtent.z : 0.0,
  };
  const invX = quantScale.x > 0.0 ? 1.0 / quantScale.x : 0.0;
  const invY = quantScale.y > 0.0 ? 1.0 / quantScale.y : 0.0;
  const invZ = quantScale.z > 0.0 ? 1.0 / quantScale.z : 0.0;

  const vertices = new Uint16Array(triCount * 3 * 4);
  const numChunks = Math.ceil(triCount / CHUNK_TRIS);
  const chunks = new Array(numChunks);

  const tmpTri = new Float64Array(10); // x0,y0,z0, x1,y1,z1, x2,y2,z2, attr

  for (let c = 0; c < numChunks; c++) {
    const t0 = c * CHUNK_TRIS;
    const t1 = Math.min(triCount, t0 + CHUNK_TRIS);
    const firstVert = t0 * 3;
    const chTris = t1 - t0;
    const vertCount = chTris * 3;

    let cminX = Infinity, cminY = Infinity, cminZ = Infinity;
    let cmaxX = -Infinity, cmaxY = -Infinity, cmaxZ = -Infinity;
    let sumNx = 0.0, sumNy = 0.0, sumNz = 0.0;
    let validNormals = 0;

    for (let t = t0; t < t1; t++) {
      readTriFn(t, tmpTri);
      let x0 = tmpTri[0], y0 = tmpTri[1], z0 = tmpTri[2];
      let x1 = tmpTri[3], y1 = tmpTri[4], z1 = tmpTri[5];
      let x2 = tmpTri[6], y2 = tmpTri[7], z2 = tmpTri[8];
      const attr = tmpTri[9] | 0;

      if (!isFiniteTri(x0, y0, z0, x1, y1, z1, x2, y2, z2)) {
        x0 = x1 = x2 = bboxMin.x;
        y0 = y1 = y2 = bboxMin.y;
        z0 = z1 = z2 = bboxMin.z;
      }

      const qx0 = quantizeCoord(x0, bboxMin.x, invX);
      const qy0 = quantizeCoord(y0, bboxMin.y, invY);
      const qz0 = quantizeCoord(z0, bboxMin.z, invZ);
      const qx1 = quantizeCoord(x1, bboxMin.x, invX);
      const qy1 = quantizeCoord(y1, bboxMin.y, invY);
      const qz1 = quantizeCoord(z1, bboxMin.z, invZ);
      const qx2 = quantizeCoord(x2, bboxMin.x, invX);
      const qy2 = quantizeCoord(y2, bboxMin.y, invY);
      const qz2 = quantizeCoord(z2, bboxMin.z, invZ);

      const base = t * 12;
      vertices[base + 0] = qx0; vertices[base + 1] = qy0; vertices[base + 2] = qz0; vertices[base + 3] = attr;
      vertices[base + 4] = qx1; vertices[base + 5] = qy1; vertices[base + 6] = qz1; vertices[base + 7] = attr;
      vertices[base + 8] = qx2; vertices[base + 9] = qy2; vertices[base + 10] = qz2; vertices[base + 11] = attr;

      const dx0 = bboxMin.x + qx0 * INV_65535 * quantScale.x;
      const dy0 = bboxMin.y + qy0 * INV_65535 * quantScale.y;
      const dz0 = bboxMin.z + qz0 * INV_65535 * quantScale.z;
      const dx1 = bboxMin.x + qx1 * INV_65535 * quantScale.x;
      const dy1 = bboxMin.y + qy1 * INV_65535 * quantScale.y;
      const dz1 = bboxMin.z + qz1 * INV_65535 * quantScale.z;
      const dx2 = bboxMin.x + qx2 * INV_65535 * quantScale.x;
      const dy2 = bboxMin.y + qy2 * INV_65535 * quantScale.y;
      const dz2 = bboxMin.z + qz2 * INV_65535 * quantScale.z;

      if (dx0 < cminX) cminX = dx0; if (dx1 < cminX) cminX = dx1; if (dx2 < cminX) cminX = dx2;
      if (dy0 < cminY) cminY = dy0; if (dy1 < cminY) cminY = dy1; if (dy2 < cminY) cminY = dy2;
      if (dz0 < cminZ) cminZ = dz0; if (dz1 < cminZ) cminZ = dz1; if (dz2 < cminZ) cminZ = dz2;

      if (dx0 > cmaxX) cmaxX = dx0; if (dx1 > cmaxX) cmaxX = dx1; if (dx2 > cmaxX) cmaxX = dx2;
      if (dy0 > cmaxY) cmaxY = dy0; if (dy1 > cmaxY) cmaxY = dy1; if (dy2 > cmaxY) cmaxY = dy2;
      if (dz0 > cmaxZ) cmaxZ = dz0; if (dz1 > cmaxZ) cmaxZ = dz1; if (dz2 > cmaxZ) cmaxZ = dz2;

      const ex1 = dx1 - dx0, ey1 = dy1 - dy0, ez1 = dz1 - dz0;
      const ex2 = dx2 - dx0, ey2 = dy2 - dy0, ez2 = dz2 - dz0;
      const crx = ey1 * ez2 - ez1 * ey2;
      const cry = ez1 * ex2 - ex1 * ez2;
      const crz = ex1 * ey2 - ey1 * ex2;
      const len = Math.hypot(crx, cry, crz);
      if (len > 1e-12) {
        const inv = 1.0 / len;
        sumNx += crx * inv;
        sumNy += cry * inv;
        sumNz += crz * inv;
        validNormals++;
      }
    }

    if (cminX > cmaxX) {
      chunks[c] = {
        firstVert, vertCount, triCount: chTris,
        cx: bboxMin.x, cy: bboxMin.y, cz: bboxMin.z, radius: 0,
        ax: 0, ay: 0, az: 1, cutoff: 1, cullable: false,
      };
      continue;
    }

    const cx = (cminX + cmaxX) * 0.5;
    const cy = (cminY + cmaxY) * 0.5;
    const cz = (cminZ + cmaxZ) * 0.5;

    let maxR2 = 0.0;
    const vStart = firstVert * 4;
    const vEnd = (firstVert + vertCount) * 4;
    for (let vi = vStart; vi < vEnd; vi += 4) {
      const rx = bboxMin.x + vertices[vi] * INV_65535 * quantScale.x - cx;
      const ry = bboxMin.y + vertices[vi + 1] * INV_65535 * quantScale.y - cy;
      const rz = bboxMin.z + vertices[vi + 2] * INV_65535 * quantScale.z - cz;
      const r2 = rx * rx + ry * ry + rz * rz;
      if (r2 > maxR2) maxR2 = r2;
    }
    const radius = Math.sqrt(maxR2);

    const sumLen = Math.hypot(sumNx, sumNy, sumNz);
    let ax = 0, ay = 0, az = 1, cutoff = 1.0, cullable = false;

    if (validNormals > 0 && sumLen >= 1e-6) {
      ax = sumNx / sumLen;
      ay = sumNy / sumLen;
      az = sumNz / sumLen;
      let minDot = 1.0;

      for (let t = t0; t < t1; t++) {
        const b = t * 12;
        const dx0 = bboxMin.x + vertices[b + 0] * INV_65535 * quantScale.x;
        const dy0 = bboxMin.y + vertices[b + 1] * INV_65535 * quantScale.y;
        const dz0 = bboxMin.z + vertices[b + 2] * INV_65535 * quantScale.z;
        const dx1 = bboxMin.x + vertices[b + 4] * INV_65535 * quantScale.x;
        const dy1 = bboxMin.y + vertices[b + 5] * INV_65535 * quantScale.y;
        const dz1 = bboxMin.z + vertices[b + 6] * INV_65535 * quantScale.z;
        const dx2 = bboxMin.x + vertices[b + 8] * INV_65535 * quantScale.x;
        const dy2 = bboxMin.y + vertices[b + 9] * INV_65535 * quantScale.y;
        const dz2 = bboxMin.z + vertices[b + 10] * INV_65535 * quantScale.z;

        const ex1 = dx1 - dx0, ey1 = dy1 - dy0, ez1 = dz1 - dz0;
        const ex2 = dx2 - dx0, ey2 = dy2 - dy0, ez2 = dz2 - dz0;
        const crx = ey1 * ez2 - ez1 * ey2;
        const cry = ez1 * ex2 - ex1 * ez2;
        const crz = ex1 * ey2 - ey1 * ex2;
        const len = Math.hypot(crx, cry, crz);
        if (len > 1e-12) {
          const d = (crx * ax + cry * ay + crz * az) / len;
          if (d < minDot) minDot = d;
        }
      }

      if (minDot > 0.05) {
        const sinAlpha = Math.sqrt(Math.max(0.0, 1.0 - minDot * minDot));
        cutoff = Math.min(0.999, sinAlpha + 1e-4);
        cullable = true;
      }
    }

    chunks[c] = {
      firstVert, vertCount, triCount: chTris,
      cx, cy, cz, radius,
      ax, ay, az, cutoff, cullable,
    };
  }

  const signedVolumeMm3 = st.volume6 / 6.0;
  return {
    bboxMin,
    bboxMax,
    bboxExtent,
    quantScale,
    signedVolumeMm3,
    volumeMm3: Math.abs(signedVolumeMm3),
    invertedWinding: signedVolumeMm3 < -1e-3,
    degenerateTris: st.degenerateTris,
    areaMm2: st.area2 * 0.5,
    vertices,
    chunks,
  };
}

function isWs(c) {
  return c === 32 || c === 9 || c === 13 || c === 10;
}

const POW10_POS = [
  1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11,
  1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22,
];

function parseAsciiFloat(bytes, state) {
  let p = state.p;
  const end = bytes.length;
  while (p < end && isWs(bytes[p])) p++;
  if (p >= end) return NaN;

  let neg = false;
  if (bytes[p] === 45) { neg = true; p++; }
  else if (bytes[p] === 43) { p++; }
  if (p >= end) return NaN;

  let mant = 0;
  let digits = 0;
  let fracDigits = 0;
  let hasDigit = false;

  while (p < end && bytes[p] >= 48 && bytes[p] <= 57) {
    hasDigit = true;
    if (digits < 15) {
      mant = mant * 10 + (bytes[p] - 48);
      digits++;
    } else {
      fracDigits--;
    }
    p++;
  }

  if (p < end && bytes[p] === 46) {
    p++;
    while (p < end && bytes[p] >= 48 && bytes[p] <= 57) {
      hasDigit = true;
      if (digits < 15) {
        mant = mant * 10 + (bytes[p] - 48);
        digits++;
        fracDigits++;
      }
      p++;
    }
  }

  if (!hasDigit) return NaN;

  let exp10 = -fracDigits;
  if (p < end && (bytes[p] === 101 || bytes[p] === 69)) {
    p++;
    let expNeg = false;
    if (p < end && (bytes[p] === 45 || bytes[p] === 43)) {
      expNeg = bytes[p] === 45;
      p++;
    }
    let e = 0;
    let hasE = false;
    while (p < end && bytes[p] >= 48 && bytes[p] <= 57) {
      hasE = true;
      if (e < 1000) e = e * 10 + (bytes[p] - 48);
      p++;
    }
    if (hasE) exp10 += expNeg ? -e : e;
  }

  let val = mant;
  if (exp10 > 0) {
    val *= exp10 <= 22 ? POW10_POS[exp10] : Math.pow(10.0, exp10);
  } else if (exp10 < 0) {
    const n = -exp10;
    val = n <= 22 ? val / POW10_POS[n] : val * Math.pow(10.0, exp10);
  }
  state.p = p;
  return neg ? -val : val;
}

function parseAsciiStl(bytes) {
  const end = bytes.length;
  let cap = Math.max(128, ((end / 140) | 0) * 9);
  let raw = new Float32Array(cap);
  let rawLen = 0;

  const fstate = { p: 0 };
  let p = 0;
  let vc = 0;
  let tx0 = 0, ty0 = 0, tz0 = 0, tx1 = 0, ty1 = 0, tz1 = 0;

  while (p < end) {
    while (p < end && isWs(bytes[p])) p++;
    if (p >= end) break;

    // Match "vertex" (118,101,114,116,101,120) followed by whitespace
    if (
      p + 7 <= end &&
      bytes[p] === 118 && bytes[p + 1] === 101 && bytes[p + 2] === 114 &&
      bytes[p + 3] === 116 && bytes[p + 4] === 101 && bytes[p + 5] === 120 &&
      isWs(bytes[p + 6])
    ) {
      fstate.p = p + 6;
      const x = parseAsciiFloat(bytes, fstate);
      const y = parseAsciiFloat(bytes, fstate);
      const z = parseAsciiFloat(bytes, fstate);
      p = fstate.p;
      if (!Number.isNaN(x) && !Number.isNaN(y) && !Number.isNaN(z)) {
        if (vc === 0) { tx0 = x; ty0 = y; tz0 = z; vc = 1; }
        else if (vc === 1) { tx1 = x; ty1 = y; tz1 = z; vc = 2; }
        else {
          if (rawLen + 9 > raw.length) {
            const next = new Float32Array(raw.length * 2);
            next.set(raw);
            raw = next;
          }
          raw[rawLen++] = tx0; raw[rawLen++] = ty0; raw[rawLen++] = tz0;
          raw[rawLen++] = tx1; raw[rawLen++] = ty1; raw[rawLen++] = tz1;
          raw[rawLen++] = x; raw[rawLen++] = y; raw[rawLen++] = z;
          vc = 0;
        }
      }
    }

    const nl = bytes.indexOf(10, p);
    if (nl === -1) break;
    p = nl + 1;
  }

  const triCount = (rawLen / 9) | 0;
  if (triCount === 0) {
    return { ok: false, error: 'ASCII STL contains 0 triangles' };
  }

  const st = createPass1Stats();
  for (let t = 0; t < triCount; t++) {
    const b = t * 9;
    accumulateTriStats(
      raw[b], raw[b + 1], raw[b + 2],
      raw[b + 3], raw[b + 4], raw[b + 5],
      raw[b + 6], raw[b + 7], raw[b + 8],
      st
    );
  }
  if (!st.hasValid) {
    return { ok: false, error: 'ASCII STL contains no finite triangles' };
  }

  const packed = finalizeChunksAndQuantize(
    triCount,
    (t, out) => {
      const b = t * 9;
      out[0] = raw[b]; out[1] = raw[b + 1]; out[2] = raw[b + 2];
      out[3] = raw[b + 3]; out[4] = raw[b + 4]; out[5] = raw[b + 5];
      out[6] = raw[b + 6]; out[7] = raw[b + 7]; out[8] = raw[b + 8];
      out[9] = 0;
    },
    st
  );
  return { ok: true, isBinary: false, triCount, ...packed };
}

function parseBinaryStl(dv, triCount) {
  if (triCount === 0) {
    return { ok: false, error: 'STL file contains 0 triangles' };
  }
  const st = createPass1Stats();
  for (let t = 0; t < triCount; t++) {
    const off = 84 + t * 50;
    accumulateTriStats(
      dv.getFloat32(off + 12, true), dv.getFloat32(off + 16, true), dv.getFloat32(off + 20, true),
      dv.getFloat32(off + 24, true), dv.getFloat32(off + 28, true), dv.getFloat32(off + 32, true),
      dv.getFloat32(off + 36, true), dv.getFloat32(off + 40, true), dv.getFloat32(off + 44, true),
      st
    );
  }
  if (!st.hasValid) {
    return { ok: false, error: 'STL contains no finite triangles' };
  }

  const packed = finalizeChunksAndQuantize(
    triCount,
    (t, out) => {
      const off = 84 + t * 50;
      out[0] = dv.getFloat32(off + 12, true);
      out[1] = dv.getFloat32(off + 16, true);
      out[2] = dv.getFloat32(off + 20, true);
      out[3] = dv.getFloat32(off + 24, true);
      out[4] = dv.getFloat32(off + 28, true);
      out[5] = dv.getFloat32(off + 32, true);
      out[6] = dv.getFloat32(off + 36, true);
      out[7] = dv.getFloat32(off + 40, true);
      out[8] = dv.getFloat32(off + 44, true);
      out[9] = dv.getUint16(off + 48, true);
    },
    st
  );
  return { ok: true, isBinary: true, triCount, ...packed };
}

function readBinaryHeaderText(bytes) {
  let out = '';
  const lim = Math.min(80, bytes.length);
  for (let i = 0; i < lim; i++) {
    const c = bytes[i];
    if (c === 0) break;
    if (c >= 32 && c <= 126) out += String.fromCharCode(c);
  }
  return out.trim();
}

function readAsciiSolidName(bytes) {
  let p = 0;
  while (p < bytes.length && isWs(bytes[p])) p++;
  p += 5; // skip "solid"
  while (p < bytes.length && (bytes[p] === 32 || bytes[p] === 9)) p++;
  let out = '';
  while (p < bytes.length && bytes[p] !== 10 && bytes[p] !== 13 && out.length < 80) {
    const c = bytes[p++];
    if (c >= 32 && c <= 126) out += String.fromCharCode(c);
  }
  return out.trim();
}

export function parseStlBuffer(arrayBuffer, fileName = 'model.stl') {
  const t0 = performance.now();
  if (!arrayBuffer || arrayBuffer.byteLength === 0) {
    return { ok: false, error: `File is empty: ${fileName}`, name: fileName };
  }

  const fileBytes = arrayBuffer.byteLength;
  const bytes = new Uint8Array(arrayBuffer);
  const dv = new DataView(arrayBuffer);

  let result = null;
  let headerText = '';
  if (fileBytes >= 84) {
    const triCount = dv.getUint32(80, true);
    const expectedBinBytes = 84 + triCount * 50;
    const padDelta = fileBytes - expectedBinBytes;
    if (triCount > 0 && padDelta >= 0 && padDelta <= 16) {
      let onlyPadding = true;
      for (let i = expectedBinBytes; i < fileBytes; i++) {
        const b = bytes[i];
        if (b !== 0 && !isWs(b)) { onlyPadding = false; break; }
      }
      if (onlyPadding) {
        result = parseBinaryStl(dv, triCount);
        headerText = readBinaryHeaderText(bytes);
      }
    }
  }

  if (!result) {
    let p = 0;
    while (p < bytes.length && isWs(bytes[p])) p++;
    // Match "solid" (115,111,108,105,100) followed by whitespace or EOF
    if (
      bytes.length - p >= 5 &&
      bytes[p] === 115 && bytes[p + 1] === 111 && bytes[p + 2] === 108 &&
      bytes[p + 3] === 105 && bytes[p + 4] === 100 &&
      (bytes.length - p === 5 || isWs(bytes[p + 5]))
    ) {
      result = parseAsciiStl(bytes);
      headerText = readAsciiSolidName(bytes);
    } else {
      result = { ok: false, error: 'Unrecognized or truncated STL file' };
    }
  }

  const loadMs = performance.now() - t0;
  if (!result.ok) {
    return { ok: false, error: result.error, name: fileName, fileBytes, loadMs };
  }

  return {
    ...result,
    headerText,
    name: fileName,
    fileBytes,
    vramBytes: result.vertices.byteLength,
    loadMs,
  };
}
