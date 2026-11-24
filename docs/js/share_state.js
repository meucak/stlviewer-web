/**
 * Shareable State & Serverless Inline Model Codec + Smart STL URL Normalizer.
 */

export const MAX_INLINE_STL_BYTES = 120 * 1024; // 120 KB compressed budget for serverless hash links

export function normalizeStlUrl(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  let u;
  try {
    u = new URL(trimmed);
  } catch {
    return trimmed;
  }

  // GitHub blob -> raw.githubusercontent.com
  if (u.hostname === 'github.com') {
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length >= 5 && parts[2] === 'blob') {
      const user = parts[0];
      const repo = parts[1];
      const branch = parts[3];
      const filePath = parts.slice(4).join('/');
      return `https://raw.githubusercontent.com/${user}/${repo}/${branch}/${filePath}`;
    }
  }

  // Dropbox ?dl=0 -> ?dl=1
  if (u.hostname.endsWith('dropbox.com')) {
    u.searchParams.set('dl', '1');
    return u.toString();
  }

  return u.toString();
}

export function encodeViewHash(s) {
  const r = (n, d = 3) => Number((Number(n) || 0).toFixed(d));
  const flags =
    (s.ortho ? 1 : 0) |
    (s.upAxis === 'yup' ? 2 : 0) |
    (s.wireframe ? 4 : 0) |
    (s.xray ? 8 : 0) |
    (s.overhang ? 16 : 0) |
    (s.sliceEnabled ? 32 : 0) |
    (s.sliceFlip ? 64 : 0) |
    (s.darkTheme ? 128 : 0);

  const arr = [
    r(s.yaw, 3),
    r(s.pitch, 3),
    r(s.distance, 2),
    r(s.target?.x, 2),
    r(s.target?.y, 2),
    r(s.target?.z, 2),
    (s.matcap | 0) & 7,
    flags,
    (s.sliceAxis | 0) & 3,
    r(s.sliceT ?? 0.5, 3),
  ];
  return arr.join(',');
}

export function decodeViewHash(str) {
  if (!str || typeof str !== 'string') return null;
  const parts = str.split(',').map(Number);
  if (parts.length < 10 || parts.some((n) => !Number.isFinite(n))) return null;
  const flags = parts[7] | 0;
  return {
    yaw: parts[0],
    pitch: parts[1],
    distance: Math.max(0.01, parts[2]),
    target: { x: parts[3], y: parts[4], z: parts[5] },
    matcap: Math.max(0, Math.min(3, parts[6] | 0)),
    ortho: !!(flags & 1),
    upAxis: flags & 2 ? 'yup' : 'zup',
    wireframe: !!(flags & 4),
    xray: !!(flags & 8),
    overhang: !!(flags & 16),
    sliceEnabled: !!(flags & 32),
    sliceFlip: !!(flags & 64),
    darkTheme: !!(flags & 128),
    sliceAxis: Math.max(0, Math.min(2, parts[8] | 0)),
    sliceT: Math.max(0, Math.min(1, parts[9])),
  };
}

function bytesToBase64Url(u8) {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < u8.length; i += step) {
    bin += String.fromCharCode(...u8.subarray(i, i + step));
  }
  const b64 = typeof btoa === 'function' ? btoa(bin) : Buffer.from(u8).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(b64url) {
  const norm = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = norm.length % 4 === 0 ? '' : '='.repeat(4 - (norm.length % 4));
  if (typeof atob === 'function') {
    const bin = atob(norm + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(norm + pad, 'base64'));
}

async function gzipCompress(u8) {
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  const wDone = writer.write(u8).then(() => writer.close());
  const reader = cs.readable.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await wDone;
  const out = new Uint8Array(total);
  let off = 0;
  for (const ch of chunks) { out.set(ch, off); off += ch.byteLength; }
  return out;
}

async function gzipDecompress(u8) {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  const wDone = writer.write(u8).then(() => writer.close());
  const reader = ds.readable.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await wDone;
  const out = new Uint8Array(total);
  let off = 0;
  for (const ch of chunks) { out.set(ch, off); off += ch.byteLength; }
  return out;
}

export async function encodeInlineModel(arrayBuffer, name = 'model.stl') {
  if (typeof CompressionStream === 'undefined') {
    return { ok: false, reason: 'no-compression-stream' };
  }
  const cleanName = String(name || 'model.stl').slice(0, 64);
  const gz = await gzipCompress(new Uint8Array(arrayBuffer));
  if (gz.byteLength > MAX_INLINE_STL_BYTES) {
    return { ok: false, reason: 'too-large', compressedBytes: gz.byteLength };
  }
  const b64 = bytesToBase64Url(gz);
  const token = `${encodeURIComponent(cleanName)}.${b64}`;
  return { ok: true, token, compressedBytes: gz.byteLength };
}

export async function decodeInlineModel(token) {
  if (!token || typeof token !== 'string' || typeof DecompressionStream === 'undefined') {
    return { ok: false };
  }
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return { ok: false };
  try {
    const name = decodeURIComponent(token.slice(0, dot));
    const gz = base64UrlToBytes(token.slice(dot + 1));
    const raw = await gzipDecompress(gz);
    return { ok: true, name, buffer: raw.buffer };
  } catch {
    return { ok: false };
  }
}
