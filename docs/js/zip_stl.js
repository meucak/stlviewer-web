/**
 * Zero-dependency client-side ZIP -> STL extractor.
 * Parses ZIP Central Directory & Local File Headers; supports Method 0 (Store)
 * and Method 8 (Deflate via native DecompressionStream('deflate-raw')).
 */

async function inflateRawBytes(compressed) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Browser does not support DecompressionStream for compressed ZIP entries.');
  }
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  const writePromise = writer.write(compressed).then(() => writer.close());
  const reader = ds.readable.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await writePromise;
  const out = new Uint8Array(total);
  let off = 0;
  for (const ch of chunks) {
    out.set(ch, off);
    off += ch.byteLength;
  }
  return out.buffer;
}

function findEocd(dv, len) {
  const minOffset = Math.max(0, len - 65557);
  for (let i = len - 22; i >= minOffset; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      return i;
    }
  }
  return -1;
}

export async function extractStlsFromZip(arrayBuffer, maxTotalBytes = 150 * 1024 * 1024) {
  if (!arrayBuffer || arrayBuffer.byteLength < 22) return [];
  const bytes = new Uint8Array(arrayBuffer);
  const dv = new DataView(arrayBuffer);
  const eocdOff = findEocd(dv, bytes.length);
  if (eocdOff < 0) return [];

  const totalEntries = dv.getUint16(eocdOff + 10, true);
  const cdOffset = dv.getUint32(eocdOff + 16, true);
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const results = [];
  let accumBytes = 0;
  let pos = cdOffset;

  for (let i = 0; i < totalEntries && pos + 46 <= bytes.length; i++) {
    if (dv.getUint32(pos, true) !== 0x02014b50) break;
    const method = dv.getUint16(pos + 10, true);
    const compSize = dv.getUint32(pos + 20, true);
    const uncompSize = dv.getUint32(pos + 24, true);
    const nameLen = dv.getUint16(pos + 28, true);
    const extraLen = dv.getUint16(pos + 30, true);
    const commentLen = dv.getUint16(pos + 32, true);
    const localHeaderOff = dv.getUint32(pos + 42, true);

    const rawName = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
    pos += 46 + nameLen + extraLen + commentLen;

    if (rawName.endsWith('/')) continue;
    if (rawName.startsWith('__MACOSX/') || rawName.includes('/._') || rawName.startsWith('._')) continue;
    if (!/\.stl$/i.test(rawName)) continue;
    if (uncompSize > 80 * 1024 * 1024 || accumBytes + uncompSize > maxTotalBytes) continue;
    if (localHeaderOff + 30 > bytes.length) continue;
    if (dv.getUint32(localHeaderOff, true) !== 0x04034b50) continue;

    const lhNameLen = dv.getUint16(localHeaderOff + 26, true);
    const lhExtraLen = dv.getUint16(localHeaderOff + 28, true);
    const dataStart = localHeaderOff + 30 + lhNameLen + lhExtraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > bytes.length) continue;

    const slice = bytes.subarray(dataStart, dataEnd);
    let buffer = null;
    if (method === 0) {
      buffer = slice.slice().buffer;
    } else if (method === 8) {
      try {
        buffer = await inflateRawBytes(slice);
      } catch {
        continue;
      }
    } else {
      continue;
    }

    const baseName = rawName.split('/').pop() || rawName;
    accumBytes += buffer.byteLength;
    results.push({ name: baseName, buffer });
  }

  return results;
}
