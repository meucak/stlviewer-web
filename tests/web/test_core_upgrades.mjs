import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';

import { parseStlBuffer } from '../../docs/js/stl_parser.js';
import { DEMO_MODELS, buildBinaryStl, generateDemoStl } from '../../docs/js/demo_models.js';
import { Camera, ViewPreset } from '../../docs/js/camera.js';
import { RendererCanvas2D } from '../../docs/js/renderer_canvas2d.js';
import { encodeQrMatrix, renderQrSvg } from '../../docs/js/qr_encoder.js';
import { extractStlsFromZip } from '../../docs/js/zip_stl.js';
import { MATERIALS, estimatePrint, formatDim, checkBedFit } from '../../docs/js/print_calc.js';
import {
  normalizeStlUrl,
  encodeViewHash,
  decodeViewHash,
  encodeInlineModel,
  decodeInlineModel,
} from '../../docs/js/share_state.js';
import { TRANSLATIONS, createTranslator } from '../../docs/js/i18n.js';

function approx(a, b, eps = 1e-3) {
  assert.ok(Math.abs(a - b) <= eps, `Expected ${a} ≈ ${b} (eps=${eps})`);
}

function makeCubeTriangles(x0, y0, z0, x1, y1, z1, invert = false) {
  const tris = [];
  const q = (ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz) => {
    if (!invert) {
      tris.push(ax, ay, az, bx, by, bz, cx, cy, cz);
      tris.push(ax, ay, az, cx, cy, cz, dx, dy, dz);
    } else {
      tris.push(ax, ay, az, cx, cy, cz, bx, by, bz);
      tris.push(ax, ay, az, dx, dy, dz, cx, cy, cz);
    }
  };
  q(x0, y0, z0, x0, y1, z0, x1, y1, z0, x1, y0, z0); // -Z
  q(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1); // +Z
  q(x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1); // -Y
  q(x1, y1, z0, x0, y1, z0, x0, y1, z1, x1, y1, z1); // +Y
  q(x0, y1, z0, x0, y0, z0, x0, y0, z1, x0, y1, z1); // -X
  q(x1, y0, z0, x1, y1, z0, x1, y1, z1, x1, y0, z1); // +X
  return tris;
}

function buildMinimalZip(entries) {
  // entries: [{ name, data: Uint8Array, compress: boolean }]
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[i] = c >>> 0;
  }
  const crc32 = (u8) => {
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = crcTable[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  for (const e of entries) {
    const nameBytes = new TextEncoder().encode(e.name);
    const raw = e.data;
    const method = e.compress ? 8 : 0;
    const payload = e.compress ? new Uint8Array(deflateRawSync(raw)) : raw;
    const crc = crc32(raw);

    const lh = new ArrayBuffer(30 + nameBytes.length);
    const ldv = new DataView(lh);
    ldv.setUint32(0, 0x04034b50, true);
    ldv.setUint16(4, 20, true);
    ldv.setUint16(8, method, true);
    ldv.setUint32(14, crc, true);
    ldv.setUint32(18, payload.length, true);
    ldv.setUint32(22, raw.length, true);
    ldv.setUint16(26, nameBytes.length, true);
    new Uint8Array(lh, 30).set(nameBytes);

    const ch = new ArrayBuffer(46 + nameBytes.length);
    const cdv = new DataView(ch);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint16(10, method, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, payload.length, true);
    cdv.setUint32(24, raw.length, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint32(42, offset, true);
    new Uint8Array(ch, 46).set(nameBytes);

    localParts.push(new Uint8Array(lh), payload);
    centralParts.push(new Uint8Array(ch));
    offset += lh.byteLength + payload.length;
  }

  const centralSize = centralParts.reduce((s, p) => s + p.length, 0);
  const eocd = new ArrayBuffer(22);
  const edv = new DataView(eocd);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(8, entries.length, true);
  edv.setUint16(10, entries.length, true);
  edv.setUint32(12, centralSize, true);
  edv.setUint32(16, offset, true);

  const totalLen = offset + centralSize + 22;
  const out = new Uint8Array(totalLen);
  let p = 0;
  for (const part of [...localParts, ...centralParts, new Uint8Array(eocd)]) {
    out.set(part, p);
    p += part.length;
  }
  return out.buffer;
}

test('demo_models: all 3 CAD samples have strictly outward CCW winding (positive signed volume)', () => {
  for (const dm of DEMO_MODELS) {
    const buf = generateDemoStl(dm.id);
    const parsed = parseStlBuffer(buf, dm.name);
    assert.equal(parsed.ok, true);
    assert.ok(
      parsed.signedVolumeMm3 > 1000,
      `${dm.id} has non-positive signedVolumeMm3=${parsed.signedVolumeMm3} (inside-out mesh!)`
    );
  }
});

test('stl_parser: reports signedVolumeMm3, inverted flag, degenerateTris, headerText, and trailing padding', () => {
  const outCube = buildBinaryStl(makeCubeTriangles(0, 0, 0, 10, 10, 10, false), 'stlviewer test header');
  const mOut = parseStlBuffer(outCube, 'out.stl');
  assert.equal(mOut.ok, true);
  approx(mOut.signedVolumeMm3, 1000, 0.5);
  assert.equal(mOut.invertedWinding, false);
  assert.equal(mOut.degenerateTris, 0);
  assert.equal(mOut.headerText, 'stlviewer test header');

  const inCube = buildBinaryStl(makeCubeTriangles(0, 0, 0, 10, 10, 10, true), 'inverted');
  const mIn = parseStlBuffer(inCube, 'in.stl');
  assert.equal(mIn.ok, true);
  approx(mIn.signedVolumeMm3, -1000, 0.5);
  assert.equal(mIn.invertedWinding, true);

  // Binary STL with 2 trailing null padding bytes + 1 degenerate triangle
  const trisWithDegen = [...makeCubeTriangles(0, 0, 0, 10, 10, 10), 0, 0, 0, 0, 0, 0, 1, 0, 0];
  const rawBin = new Uint8Array(buildBinaryStl(trisWithDegen, 'padded'));
  const padded = new Uint8Array(rawBin.length + 2);
  padded.set(rawBin);
  const mPad = parseStlBuffer(padded.buffer, 'padded.stl');
  assert.equal(mPad.ok, true);
  assert.equal(mPad.triCount, 13);
  assert.equal(mPad.degenerateTris, 1);
});

test('qr_encoder: encodes short, medium & long URLs into valid ISO/IEC 18004 SVG QR codes', () => {
  const urls = [
    'http://stl',
    'https://meucak.github.io/stlviewer-web/',
    'https://alpha-beta-gamma-delta.trycloudflare.com/s/ab12cd34#v=0.78,-0.61,120.5,0,0,15,0,0,0',
  ];
  for (const url of urls) {
    const q = encodeQrMatrix(url);
    assert.ok(q.size >= 21 && q.size <= 81);
    assert.equal(q.modules.length, q.size);
    // Top-left 7x7 finder corners must be dark
    assert.equal(q.modules[0][0], 1);
    assert.equal(q.modules[0][6], 1);
    assert.equal(q.modules[6][0], 1);
    assert.equal(q.modules[3][3], 1);
    const svg = renderQrSvg(url, { label: 'STLViewer QR' });
    assert.ok(svg.startsWith('<svg '));
    assert.ok(svg.includes('<path '));
    assert.ok(svg.includes('STLViewer QR'));
  }
});

test('zip_stl: extracts stored & deflated .stl files and skips __MACOSX and non-STL files', async () => {
  const cubeA = new Uint8Array(buildBinaryStl(makeCubeTriangles(0, 0, 0, 5, 5, 5), 'a'));
  const cubeB = new Uint8Array(buildBinaryStl(makeCubeTriangles(0, 0, 0, 8, 8, 8), 'b'));
  const zipBuf = buildMinimalZip([
    { name: 'README.txt', data: new TextEncoder().encode('hello'), compress: false },
    { name: '__MACOSX/._partA.stl', data: cubeA, compress: false },
    { name: 'parts/partA.stl', data: cubeA, compress: false },
    { name: 'parts/partB.STL', data: cubeB, compress: true },
  ]);

  const extracted = await extractStlsFromZip(zipBuf);
  assert.equal(extracted.length, 2);
  assert.equal(extracted[0].name, 'partA.stl');
  assert.equal(extracted[1].name, 'partB.STL');
  assert.equal(parseStlBuffer(extracted[0].buffer, extracted[0].name).ok, true);
  assert.equal(parseStlBuffer(extracted[1].buffer, extracted[1].name).ok, true);
});

test('print_calc: accurate material weight, filament length, unit formatting & build plate fit', () => {
  assert.ok(MATERIALS.length >= 5);
  const full = estimatePrint(100000, 12000, 'pla', 100); // 100 cm³ solid PLA
  approx(full.weightGrams, 124.0, 0.5);
  assert.ok(full.filamentMeters > 30 && full.filamentMeters < 50);

  const sparse = estimatePrint(100000, 12000, 'pla', 20);
  assert.ok(sparse.weightGrams < full.weightGrams && sparse.weightGrams > 20);

  assert.equal(formatDim(25.4, 'mm'), '25.4 mm');
  assert.equal(formatDim(25.4, 'cm'), '2.54 cm');
  assert.equal(formatDim(25.4, 'in'), '1.00 in');

  assert.equal(checkBedFit({ x: 180, y: 180, z: 100 }, { x: 220, y: 220, z: 250 }).fits, true);
  assert.equal(checkBedFit({ x: 260, y: 100, z: 100 }, { x: 220, y: 220, z: 250 }).fits, false);
});

test('share_state: URL normalization, camera hash round-trip & serverless gzipped STL round-trip', async () => {
  assert.equal(
    normalizeStlUrl(' https://github.com/meucak/stlviewer/blob/main/part.stl '),
    'https://raw.githubusercontent.com/meucak/stlviewer/main/part.stl'
  );
  assert.equal(
    normalizeStlUrl('https://www.dropbox.com/s/abc/test.stl?dl=0'),
    'https://www.dropbox.com/s/abc/test.stl?dl=1'
  );

  const encoded = encodeViewHash({
    yaw: -0.785,
    pitch: 0.615,
    distance: 125.4,
    target: { x: 1.5, y: -2.25, z: 10.0 },
    ortho: true,
    upAxis: 'yup',
    matcap: 2,
    wireframe: true,
    xray: false,
    overhang: true,
    sliceEnabled: true,
    sliceAxis: 1,
    sliceFlip: true,
    sliceT: 0.42,
    darkTheme: false,
  });
  const decoded = decodeViewHash(encoded);
  assert.ok(decoded);
  approx(decoded.yaw, -0.785, 1e-2);
  approx(decoded.distance, 125.4, 0.2);
  assert.equal(decoded.ortho, true);
  assert.equal(decoded.upAxis, 'yup');
  assert.equal(decoded.matcap, 2);
  assert.equal(decoded.overhang, true);
  assert.equal(decoded.sliceEnabled, true);
  assert.equal(decoded.sliceAxis, 1);
  assert.equal(decoded.sliceFlip, true);
  approx(decoded.sliceT, 0.42, 0.01);
  assert.equal(decoded.darkTheme, false);
  assert.equal(decodeViewHash('not-valid-junk'), null);

  const tinyStl = buildBinaryStl(makeCubeTriangles(0, 0, 0, 10, 10, 10), 'tiny');
  const packed = await encodeInlineModel(tinyStl, 'tiny.stl');
  assert.equal(packed.ok, true);
  const unpacked = await decodeInlineModel(packed.token);
  assert.equal(unpacked.ok, true);
  assert.equal(unpacked.name, 'tiny.stl');
  assert.equal(unpacked.buffer.byteLength, tinyStl.byteLength);
  assert.deepEqual(new Uint8Array(unpacked.buffer), new Uint8Array(tinyStl));
});

test('i18n: Turkish and English dictionaries have identical key coverage', () => {
  const trKeys = Object.keys(TRANSLATIONS.tr).sort();
  const enKeys = Object.keys(TRANSLATIONS.en).sort();
  assert.deepEqual(trKeys, enKeys);
  assert.ok(trKeys.length >= 40);
  const t = createTranslator('tr');
  assert.ok(typeof t('open') === 'string' && t('open').length > 0);
});

test('renderer_canvas2d: pixel-exact Z-buffer eliminates sorting glitches and inter-triangle seams', () => {
  const W = 120, H = 120;
  let lastImg = null;
  const mockCtx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineJoin: 'round',
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: (img) => { lastImg = img; },
    createLinearGradient: () => ({ addColorStop() {} }),
    fillRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    fill() {},
    stroke() {},
  };
  const mockCanvas = { getContext: (k) => (k === '2d' ? mockCtx : null) };
  const r = new RendererCanvas2D(mockCanvas);
  r.init(W, H, 1);

  // Two overlapping faces at y=-10 (closer to Front camera) and y=+10 (farther):
  // Put the CLOSER quad FIRST in triangle list and FARTHER quad SECOND so naive draw order would fail;
  // also make closer quad span the center so we verify zero seam on the shared diagonal!
  const tris = [
    // Closer quad at y=-10 spanning [-10..10] in X,Z (2 triangles sharing diagonal)
    -10, -10, -10,  10, -10, -10,  10, -10,  10,
    -10, -10, -10,  10, -10,  10, -10, -10,  10,
    // Farther tilted quad behind at y=+5 (different normal -> noticeably different MatCap color!)
    -10,   5, -10,  10,  10, -10,  10,  10,  10,
    -10,   5, -10,  10,  10,  10, -10,   5,  10,
  ];
  const mesh = parseStlBuffer(buildBinaryStl(tris, 'zbuf'), 'zbuf.stl');
  r.uploadMesh(mesh);

  const cam = new Camera();
  cam.frameBounds(mesh.bboxMin, mesh.bboxMax, W, H, false);
  cam.setPreset(ViewPreset.Front, false);

  const state = {
    darkTheme: true,
    matcap: 0,
    wireframe: false,
    xray: false,
    overhang: false,
    twoSided: true,
    showGrid: false,
    showHud: true,
    showBed: false,
    sliceEnabled: false,
    sliceAxis: 2,
    sliceFlip: false,
    sliceT: 0.5,
    measureHasA: false,
    measureHasB: false,
    triadCenterCss: { x: 80, y: 40 },
  };
  const res = r.renderFrame(mesh, cam, state);
  assert.ok(lastImg, 'RendererCanvas2D must rasterize into ImageData Z-buffer');
  // Center pixel (60, 60) sits right on the shared diagonal of the front quad -> must be solid Clay, NOT dark background seam!
  const midIdx = (60 * W + 60) * 4;
  const lum = lastImg.data[midIdx] + lastImg.data[midIdx + 1] + lastImg.data[midIdx + 2];
  assert.ok(lum > 200, `Center pixel on shared diagonal had low luminance=${lum} (seam or background!)`);
  // Dynamic triad center must be respected
  const avgX = (res.axisTipsCss[0].x + res.axisTipsCss[1].x + res.axisTipsCss[2].x) / 3;
  const avgY = (res.axisTipsCss[0].y + res.axisTipsCss[1].y + res.axisTipsCss[2].y) / 3;
  assert.ok(Math.abs(avgX - 80) < 40 && Math.abs(avgY - 40) < 40, 'Triad must follow triadCenterCss');
});
