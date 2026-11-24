import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAppServer, isPrivateIp, validateStlBytes } from '../../server/server.mjs';
import { buildBinaryStl } from '../../docs/js/demo_models.js';

function makeSampleStlBuffer() {
  const tris = [
    0, 0, 0, 10, 0, 0, 10, 10, 0,
    0, 0, 0, 10, 10, 0, 0, 10, 0,
  ];
  return Buffer.from(buildBinaryStl(tris, 'server-test-stl'));
}

test('server helpers: isPrivateIp blocks all loopback/LAN/metadata/CGNAT/ULA ranges', () => {
  for (const ip of [
    '127.0.0.1',
    '127.255.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.100',
    '169.254.169.254',
    '100.69.155.110',
    '0.0.0.0',
    '::1',
    '::',
    'fc00::1',
    'fd12::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:192.168.1.1',
  ]) {
    assert.equal(isPrivateIp(ip), true, `Expected private IP blocked: ${ip}`);
  }
  for (const ip of ['1.1.1.1', '8.8.8.8', '185.199.108.153', '2606:4700:4700::1111']) {
    assert.equal(isPrivateIp(ip), false, `Expected public IP allowed: ${ip}`);
  }
});

test('server helpers: validateStlBytes accepts valid binary & ASCII STLs and rejects junk', () => {
  assert.equal(validateStlBytes(makeSampleStlBuffer()).ok, true);
  assert.equal(
    validateStlBytes(Buffer.from('solid a\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid a\n')).ok,
    true
  );
  assert.equal(validateStlBytes(Buffer.from('<html>not an stl</html>')).ok, false);
  assert.equal(validateStlBytes(Buffer.alloc(0)).ok, false);
});

test('server integration: health, access-info, share upload/dedup/HTML injection, library & SSRF defense', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stlviewer-srv-'));
  const dataDir = path.join(tmp, 'data');
  const libDir = path.join(tmp, 'lib');
  const docsDir = path.join(tmp, 'docs');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(libDir, 'aircraft'), { recursive: true });
  fs.mkdirSync(docsDir, { recursive: true });

  fs.writeFileSync(
    path.join(docsDir, 'index.html'),
    '<!DOCTYPE html><html><head><title>STLViewer Web</title></head><body>OK</body></html>'
  );
  const sampleBuf = makeSampleStlBuffer();
  fs.writeFileSync(path.join(libDir, 'aircraft', 'wing.stl'), sampleBuf);
  fs.writeFileSync(path.join(libDir, 'secret.txt'), 'TOP_SECRET');
  const tunnelLog = path.join(tmp, 'cloudflared.log');
  fs.writeFileSync(tunnelLog, 'INF +--- https://demo-stl-tunnel.trycloudflare.com ---+\n');

  const srv = createAppServer({
    docsDir,
    dataDir,
    libraryDirs: [{ label: 'TestCAD', dir: libDir }],
    tunnelLogPath: tunnelLog,
    maxShareBytes: 1024 * 1024,
  });

  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = srv.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    // 1. Health & access-info
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.libraryCount, 1);
    assert.equal(health.tunnelUrl, 'https://demo-stl-tunnel.trycloudflare.com');

    const access = await (await fetch(`${base}/api/access-info`)).json();
    assert.equal(access.serverMode, true);
    assert.equal(access.publicTunnel, 'https://demo-stl-tunnel.trycloudflare.com');
    assert.equal(access.lanShort, 'http://stl');

    // 2. Share upload + SHA-256 deduplication + download + /s/:id HTML injection
    const up1 = await fetch(`${base}/api/share`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Filename': 'my <script>part.stl',
      },
      body: sampleBuf,
    });
    assert.equal(up1.status, 201);
    const j1 = await up1.json();
    assert.equal(j1.ok, true);
    assert.match(j1.id, /^[a-f0-9]{10}$/);
    assert.ok(!j1.name.includes('<script>'));

    // Uploading exact same bytes deduplicates to identical ID
    const up2 = await fetch(`${base}/api/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': 'dup.stl' },
      body: sampleBuf,
    });
    const j2 = await up2.json();
    assert.equal(j2.id, j1.id);

    // Download shared STL
    const dl = await fetch(`${base}/api/share/${j1.id}`);
    assert.equal(dl.status, 200);
    const dlBuf = Buffer.from(await dl.arrayBuffer());
    assert.deepEqual(dlBuf, sampleBuf);

    // /s/:id injects share meta tag & escaped title
    const shareHtml = await (await fetch(`${base}/s/${j1.id}`)).text();
    assert.ok(shareHtml.includes(`name="stlviewer-share-id" content="${j1.id}"`));
    assert.ok(!shareHtml.includes('<script>'));

    // Reject junk non-STL upload
    const badUp = await fetch(`${base}/api/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': 'bad.stl' },
      body: Buffer.from('not an stl payload at all'),
    });
    assert.equal(badUp.status, 415);

    // 3. Library listing + traversal & non-STL defense
    const lib = await (await fetch(`${base}/api/library`)).json();
    assert.equal(lib.items.length, 1);
    assert.equal(lib.items[0].name, 'wing.stl');

    const libFile = await fetch(`${base}/api/library/file?root=0&path=${encodeURIComponent(lib.items[0].relPath)}`);
    assert.equal(libFile.status, 200);
    assert.deepEqual(Buffer.from(await libFile.arrayBuffer()), sampleBuf);

    // Traversal attack blocked
    const trav = await fetch(`${base}/api/library/file?root=0&path=${encodeURIComponent('../secret.txt')}`);
    assert.equal(trav.status, 403);
    const nonStl = await fetch(`${base}/api/library/file?root=0&path=${encodeURIComponent('secret.txt')}`);
    assert.equal(nonStl.status, 403);

    // 4. SSRF defense on /api/proxy
    const ssrf1 = await fetch(`${base}/api/proxy?url=${encodeURIComponent('http://127.0.0.1:8097/api/health')}`);
    assert.equal(ssrf1.status, 403);
    const ssrf2 = await fetch(`${base}/api/proxy?url=${encodeURIComponent('http://169.254.169.254/latest/meta-data/')}`);
    assert.equal(ssrf2.status, 403);
    const ssrf3 = await fetch(`${base}/api/proxy?url=${encodeURIComponent('file:///etc/passwd')}`);
    assert.equal(ssrf3.status, 400);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
