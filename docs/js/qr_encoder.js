/**
 * Pure-JS Offline ISO/IEC 18004 QR Code Generator (Byte Mode, ECC Level L, Versions 1–16).
 * Zero external API calls — renders crisp inline SVG QR matrices completely offline.
 */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function rsGeneratorPoly(ecCount) {
  let poly = [1];
  for (let i = 0; i < ecCount; i++) {
    const next = new Array(poly.length + 1).fill(0);
    const factor = EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], factor);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(dataBytes, ecCount) {
  const gen = rsGeneratorPoly(ecCount);
  const res = new Uint8Array(dataBytes.length + ecCount);
  res.set(dataBytes);
  for (let i = 0; i < dataBytes.length; i++) {
    const coef = res[i];
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j++) {
        res[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }
  return res.subarray(dataBytes.length);
}

// ECC Level L specs: [version, totalDataCodewords, ecPerBlock, blocksG1, dataG1, blocksG2, dataG2]
const VERSION_SPECS = [
  null,
  [1, 19, 7, 1, 19, 0, 0],
  [2, 34, 10, 1, 34, 0, 0],
  [3, 55, 15, 1, 55, 0, 0],
  [4, 80, 20, 1, 80, 0, 0],
  [5, 108, 26, 1, 108, 0, 0],
  [6, 136, 18, 2, 68, 0, 0],
  [7, 156, 20, 2, 78, 0, 0],
  [8, 194, 24, 2, 97, 0, 0],
  [9, 232, 30, 2, 116, 0, 0],
  [10, 274, 18, 2, 68, 2, 69],
  [11, 324, 20, 4, 81, 0, 0],
  [12, 370, 24, 2, 92, 2, 93],
  [13, 428, 26, 4, 107, 0, 0],
  [14, 461, 30, 3, 115, 1, 116],
  [15, 523, 22, 5, 87, 1, 88],
  [16, 589, 24, 5, 98, 1, 99],
];

const ALIGN_CENTERS = [
  [], [],
  [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
  [6, 30, 54], [6, 32, 58], [6, 34, 62],
  [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74],
];

const FORMAT_INFO_L = [
  0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976,
];

const VERSION_INFO_BITS = [
  0, 0, 0, 0, 0, 0, 0,
  0x07c94, 0x085bc, 0x09a99, 0x0a4d3, 0x0bbf6,
  0x0c762, 0x0d847, 0x0e60d, 0x0f928, 0x10b78,
];

function selectVersion(byteLen) {
  for (let v = 1; v < VERSION_SPECS.length; v++) {
    const charBits = v >= 10 ? 16 : 8;
    const headerBits = 4 + charBits;
    const capBits = VERSION_SPECS[v][1] * 8;
    if (headerBits + byteLen * 8 <= capBits) return VERSION_SPECS[v];
  }
  return VERSION_SPECS[VERSION_SPECS.length - 1];
}

function buildCodewords(bytes, spec) {
  const [version, totalData, ecPerBlock, b1, d1, b2, d2] = spec;
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };

  const overheadBytes = version >= 10 ? 3 : 2;
  const maxPayloadBytes = Math.min(bytes.length, totalData - overheadBytes);
  pushBits(0b0100, 4); // Byte mode
  pushBits(maxPayloadBytes, version >= 10 ? 16 : 8);
  for (let i = 0; i < maxPayloadBytes; i++) pushBits(bytes[i], 8);

  const capBits = totalData * 8;
  const rem = capBits - bits.length;
  for (let i = 0; i < Math.min(4, rem); i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  while (bits.length < capBits) {
    pushBits(padBytes[padIdx % 2], 8);
    padIdx++;
  }

  const dataBytes = new Uint8Array(totalData);
  for (let i = 0; i < totalData; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i * 8 + j];
    dataBytes[i] = b;
  }

  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (let i = 0; i < b1; i++) {
    const blk = dataBytes.subarray(offset, offset + d1);
    dataBlocks.push(blk);
    ecBlocks.push(rsRemainder(blk, ecPerBlock));
    offset += d1;
  }
  for (let i = 0; i < b2; i++) {
    const blk = dataBytes.subarray(offset, offset + d2);
    dataBlocks.push(blk);
    ecBlocks.push(rsRemainder(blk, ecPerBlock));
    offset += d2;
  }

  const interleaved = [];
  const maxDataLen = Math.max(d1, d2);
  for (let col = 0; col < maxDataLen; col++) {
    for (const blk of dataBlocks) {
      if (col < blk.length) interleaved.push(blk[col]);
    }
  }
  for (let col = 0; col < ecPerBlock; col++) {
    for (const blk of ecBlocks) {
      interleaved.push(blk[col]);
    }
  }
  return interleaved;
}

function maskFlip(maskId, r, c) {
  switch (maskId) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return ((r >> 1) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return false;
  }
}

export function encodeQrMatrix(text) {
  const bytes = new TextEncoder().encode(String(text || 'https://meucak.github.io/stlviewer-web/'));
  const spec = selectVersion(bytes.length);
  const version = spec[0];
  const size = version * 4 + 17;

  const grid = Array.from({ length: size }, () => new Int8Array(size).fill(-1));
  const reserved = Array.from({ length: size }, () => new Uint8Array(size));

  const setModule = (r, c, val, isFunc = true) => {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    grid[r][c] = val ? 1 : 0;
    if (isFunc) reserved[r][c] = 1;
  };

  const drawFinder = (r0, c0) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = r0 + dr;
        const c = c0 + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const onBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inCenter = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setModule(r, c, inOuter && (onBorder || inCenter) ? 1 : 0, true);
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  const centers = ALIGN_CENTERS[version] || [];
  for (const r0 of centers) {
    for (const c0 of centers) {
      if (reserved[r0][c0]) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const val = Math.max(Math.abs(dr), Math.abs(dc)) === 2 || (dr === 0 && dc === 0);
          setModule(r0 + dr, c0 + dc, val ? 1 : 0, true);
        }
      }
    }
  }

  for (let i = 8; i < size - 8; i++) {
    const bit = i % 2 === 0 ? 1 : 0;
    if (!reserved[6][i]) setModule(6, i, bit, true);
    if (!reserved[i][6]) setModule(i, 6, bit, true);
  }

  setModule(4 * version + 9, 8, 1, true);
  for (let i = 0; i < 9; i++) {
    if (!reserved[8][i]) reserved[8][i] = 1;
    if (!reserved[i][8]) reserved[i][8] = 1;
  }
  for (let i = size - 8; i < size; i++) {
    reserved[8][i] = 1;
    reserved[i][8] = 1;
  }
  if (version >= 7) {
    const vBits = VERSION_INFO_BITS[version];
    for (let i = 0; i < 18; i++) {
      const bit = (vBits >> i) & 1;
      const r = Math.floor(i / 3);
      const c = size - 11 + (i % 3);
      setModule(r, c, bit, true);
      setModule(c, r, bit, true);
    }
  }

  const codewords = buildCodewords(bytes, spec);
  let bitIdx = 0;
  const totalBits = codewords.length * 8;
  let dir = -1;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let step = 0; step < size; step++) {
      const r = dir === -1 ? size - 1 - step : step;
      for (let dc = 0; dc < 2; dc++) {
        const c = col - dc;
        if (reserved[r][c]) continue;
        let bit = 0;
        if (bitIdx < totalBits) {
          bit = (codewords[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1;
          bitIdx++;
        }
        grid[r][c] = bit;
      }
    }
    dir = -dir;
  }

  const applyMaskAndFormat = (maskId) => {
    const m = grid.map((row) => new Int8Array(row));
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!reserved[r][c] && maskFlip(maskId, r, c)) m[r][c] ^= 1;
      }
    }
    const fmt = FORMAT_INFO_L[maskId];
    for (let i = 0; i < 15; i++) {
      const bit = (fmt >> i) & 1;
      if (i < 6) m[8][i] = bit;
      else if (i < 8) m[8][i + 1] = bit;
      else m[8][size - 15 + i] = bit;

      if (i < 8) m[size - 1 - i][8] = bit;
      else if (i < 9) m[7][8] = bit;
      else m[14 - i][8] = bit;
    }
    return m;
  };

  const scoreMatrix = (m) => {
    let penalty = 0;
    for (let r = 0; r < size; r++) {
      let run = 1;
      for (let c = 1; c < size; c++) {
        if (m[r][c] === m[r][c - 1]) {
          run++;
          if (run === 5) penalty += 3;
          else if (run > 5) penalty++;
        } else run = 1;
      }
    }
    for (let c = 0; c < size; c++) {
      let run = 1;
      for (let r = 1; r < size; r++) {
        if (m[r][c] === m[r - 1][c]) {
          run++;
          if (run === 5) penalty += 3;
          else if (run > 5) penalty++;
        } else run = 1;
      }
    }
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = m[r][c];
        if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) penalty += 3;
      }
    }
    return penalty;
  };

  let best = applyMaskAndFormat(0);
  let bestScore = scoreMatrix(best);
  for (let maskId = 1; maskId < 8; maskId++) {
    const candidate = applyMaskAndFormat(maskId);
    const sc = scoreMatrix(candidate);
    if (sc < bestScore) {
      bestScore = sc;
      best = candidate;
    }
  }

  return {
    version,
    size,
    modules: best.map((row) => Array.from(row)),
  };
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderQrSvg(text, options = {}) {
  const { size: matrixSize, modules } = encodeQrMatrix(text);
  const margin = Number(options.margin ?? 3);
  const viewSize = matrixSize + margin * 2;
  const fg = options.fg || '#0F172A';
  const bg = options.bg || '#FFFFFF';
  const sizePx = Number(options.size || options.width || 192);
  const label = escapeAttr(options.label || 'STLViewer QR Code');

  let d = '';
  for (let r = 0; r < matrixSize; r++) {
    for (let c = 0; c < matrixSize; c++) {
      if (modules[r][c] === 1) {
        d += `M${c + margin},${r + margin}h1v1h-1z`;
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewSize} ${viewSize}" width="${sizePx}" height="${sizePx}" shape-rendering="crispEdges" role="img" aria-label="${label}"><rect width="${viewSize}" height="${viewSize}" fill="${bg}" rx="3"/><path d="${d}" fill="${fg}"/></svg>`;
}
