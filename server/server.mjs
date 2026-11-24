import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import net from 'node:net';
import dns from 'node:dns/promises';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.stl': 'model/stl',
  '.txt': 'text/plain; charset=utf-8',
});

const COMPRESSIBLE_EXTS = new Set(['.html', '.js', '.mjs', '.css', '.svg', '.json', '.webmanifest', '.txt']);

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function sanitizeFilename(raw) {
  const base = path.basename(String(raw || 'model.stl'))
    .replace(/[\x00-\x1f<>:"/\\|?*]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  let clean = base.slice(0, 96) || 'model.stl';
  if (!/\.stl$/i.test(clean)) clean += '.stl';
  return clean;
}

export function isPrivateIp(ipRaw) {
  if (!ipRaw || typeof ipRaw !== 'string') return true;
  let ip = ipRaw.trim().toLowerCase();
  if (ip.startsWith('::ffff:')) {
    ip = ip.slice(7);
  }
  const v = net.isIP(ip);
  if (v === 4) {
    const p = ip.split('.').map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = p;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // 127.0.0.0/8
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT / Tailscale)
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 (Link-local / cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 192 && b === 0 && (p[2] === 0 || p[2] === 2)) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true; // Multicast & reserved
    return false;
  }
  if (v === 6) {
    if (ip === '::' || ip === '::1') return true;
    const firstHextet = parseInt(ip.split(':')[0] || '0', 16);
    if ((firstHextet & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
    if ((firstHextet & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((firstHextet & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    return false;
  }
  return true;
}

export function validateStlBytes(buf) {
  if (!buf || buf.length === 0) return { ok: false, reason: 'empty' };
  const len = buf.length;
  // Binary STL check (with tolerance up to 16 trailing padding bytes)
  if (len >= 84) {
    const triCount = buf.readUInt32LE(80);
    const expected = 84 + triCount * 50;
    const delta = len - expected;
    if (triCount > 0 && triCount <= 25_000_000 && delta >= 0 && delta <= 16) {
      return { ok: true, isBinary: true, triCount };
    }
  }
  // ASCII STL check
  const head = buf.subarray(0, Math.min(len, 4096)).toString('utf8').trimStart();
  if (/^solid(\s|$)/i.test(head)) {
    const sample = buf.subarray(0, Math.min(len, 65536)).toString('utf8');
    if (/\bfacet\b/i.test(sample) && /\bvertex\b/i.test(sample)) {
      return { ok: true, isBinary: false };
    }
  }
  return { ok: false, reason: 'invalid-stl' };
}

function readLatestTunnelUrl(logPath) {
  if (!logPath) return null;
  try {
    const st = fs.statSync(logPath);
    const readLen = Math.min(st.size, 65536);
    const fd = fs.openSync(logPath, 'r');
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, Math.max(0, st.size - readLen));
    fs.closeSync(fd);
    const txt = buf.toString('utf8');
    const matches = txt.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
    return matches && matches.length > 0 ? matches[matches.length - 1] : null;
  } catch {
    return null;
  }
}

function scanLibraryDirs(libraryDirs, maxDepth = 4, maxItems = 200) {
  const items = [];
  const walk = (rootIdx, rootLabel, baseDir, curDir, depth) => {
    if (depth > maxDepth || items.length >= maxItems) return;
    let entries;
    try {
      entries = fs.readdirSync(curDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (items.length >= maxItems) break;
      if (ent.name.startsWith('.') || ent.name === 'node_modules' || ent.name === '__MACOSX') continue;
      const full = path.join(curDir, ent.name);
      if (ent.isDirectory()) {
        walk(rootIdx, rootLabel, baseDir, full, depth + 1);
      } else if (ent.isFile() && /\.stl$/i.test(ent.name)) {
        try {
          const st = fs.statSync(full);
          if (st.size > 0 && st.size <= 100 * 1024 * 1024) {
            const relPath = path.relative(baseDir, full).split(path.sep).join('/');
            const folder = path.dirname(relPath) === '.' ? rootLabel : `${rootLabel}/${path.dirname(relPath)}`;
            items.push({
              root: rootIdx,
              relPath,
              name: ent.name,
              folder,
              bytes: st.size,
              mtimeMs: st.mtimeMs,
            });
          }
        } catch {}
      }
    }
  };

  libraryDirs.forEach((entry, idx) => {
    if (entry && entry.dir && fs.existsSync(entry.dir)) {
      walk(idx, entry.label || `Library ${idx + 1}`, path.resolve(entry.dir), path.resolve(entry.dir), 0);
    }
  });

  items.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return items;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function readRequestBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      total += chunk.length;
      if (total > maxBytes) {
        aborted = true;
        const err = new Error('Payload too large');
        err.statusCode = 413;
        reject(err);
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!aborted) resolve(Buffer.concat(chunks, total));
    });
    req.on('error', (err) => {
      if (!aborted) reject(err);
    });
  });
}

async function fetchPublicUrlSafe(rawUrl, maxBytes, maxRedirects = 3) {
  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let parsed;
    try {
      parsed = new URL(current);
    } catch {
      const err = new Error('Invalid URL');
      err.statusCode = 400;
      throw err;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      const err = new Error('Only http/https URLs are supported');
      err.statusCode = 400;
      throw err;
    }

    const host = parsed.hostname;
    if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.internal')) {
      const err = new Error('Private/local hosts are blocked');
      err.statusCode = 403;
      throw err;
    }

    if (net.isIP(host)) {
      if (isPrivateIp(host)) {
        const err = new Error('Private IP addresses are blocked');
        err.statusCode = 403;
        throw err;
      }
    } else {
      let addrs;
      try {
        addrs = await dns.lookup(host, { all: true });
      } catch {
        const err = new Error('Failed to resolve host');
        err.statusCode = 502;
        throw err;
      }
      if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
        const err = new Error('Resolved IP is private/blocked');
        err.statusCode = 403;
        throw err;
      }
    }

    const result = await new Promise((resolve, reject) => {
      const mod = parsed.protocol === 'https:' ? https : http;
      const req = mod.request(
        parsed,
        {
          method: 'GET',
          headers: { 'User-Agent': 'STLViewer-Web-Proxy/1.0' },
          timeout: 15000,
        },
        (resp) => {
          const code = resp.statusCode || 500;
          if (code >= 300 && code < 400 && resp.headers.location) {
            resp.resume();
            resolve({ redirect: new URL(resp.headers.location, parsed).toString() });
            return;
          }
          if (code < 200 || code >= 300) {
            resp.resume();
            const err = new Error(`Upstream HTTP ${code}`);
            err.statusCode = 502;
            reject(err);
            return;
          }
          const chunks = [];
          let total = 0;
          resp.on('data', (c) => {
            total += c.length;
            if (total > maxBytes) {
              req.destroy();
              const err = new Error('Remote STL exceeds size limit');
              err.statusCode = 413;
              reject(err);
              return;
            }
            chunks.push(c);
          });
          resp.on('end', () => resolve({ buffer: Buffer.concat(chunks, total) }));
          resp.on('error', reject);
        }
      );
      req.on('timeout', () => {
        req.destroy();
        const err = new Error('Upstream request timed out');
        err.statusCode = 504;
        reject(err);
      });
      req.on('error', (e) => {
        e.statusCode = 502;
        reject(e);
      });
      req.end();
    });

    if (result.redirect) {
      current = result.redirect;
      continue;
    }
    return result.buffer;
  }

  const err = new Error('Too many redirects');
  err.statusCode = 502;
  throw err;
}

export function createAppServer(options = {}) {
  const docsDir = path.resolve(options.docsDir || path.join(__dirname, '..', 'docs'));
  const dataDir = path.resolve(options.dataDir || path.join(__dirname, '..', 'server_data'));
  const sharesDir = path.join(dataDir, 'shares');
  fs.mkdirSync(sharesDir, { recursive: true });

  const libraryDirs = options.libraryDirs || [];
  const tunnelLogPath = options.tunnelLogPath || process.env.TUNNEL_LOG_PATH || '';
  const maxShareBytes = options.maxShareBytes || 50 * 1024 * 1024;
  const maxShareFiles = options.maxShareFiles || 200;
  const shareTtlMs = options.shareTtlMs || 7 * 24 * 3600 * 1000;
  const githubPages = options.githubPages || process.env.GITHUB_PAGES_URL || 'https://meucak.github.io/stlviewer-web/';
  const lanIp = options.lanIp || process.env.LAN_IP || '192.168.1.100';
  const tailscaleIp = options.tailscaleIp || process.env.TAILSCALE_IP || '100.69.155.110';
  const publicPort = Number(options.publicPort || process.env.PUBLIC_PORT || process.env.PORT || 8097);
  const startTime = Date.now();

  let libCache = { at: 0, items: [] };
  const getLibrary = () => {
    if (Date.now() - libCache.at > 5000) {
      libCache = { at: Date.now(), items: scanLibraryDirs(libraryDirs) };
    }
    return libCache.items;
  };

  const pruneShares = () => {
    try {
      const now = Date.now();
      const metas = [];
      for (const f of fs.readdirSync(sharesDir)) {
        if (!f.endsWith('.json')) continue;
        const p = path.join(sharesDir, f);
        try {
          const m = JSON.parse(fs.readFileSync(p, 'utf8'));
          if (m.expiresAt && m.expiresAt < now) {
            fs.rmSync(p, { force: true });
            fs.rmSync(path.join(sharesDir, `${m.id}.stl`), { force: true });
          } else {
            metas.push(m);
          }
        } catch {}
      }
      if (metas.length > maxShareFiles) {
        metas.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        const removeCount = metas.length - maxShareFiles;
        for (let i = 0; i < removeCount; i++) {
          fs.rmSync(path.join(sharesDir, `${metas[i].id}.json`), { force: true });
          fs.rmSync(path.join(sharesDir, `${metas[i].id}.stl`), { force: true });
        }
      }
    } catch {}
  };

  const countShares = () => {
    try {
      return fs.readdirSync(sharesDir).filter((f) => f.endsWith('.stl')).length;
    } catch {
      return 0;
    }
  };

  const serveStaticFile = (req, res, filePath, extraHeaders = {}) => {
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(docsDir + path.sep) && resolved !== docsDir) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    let st;
    try {
      st = fs.statSync(resolved);
      if (!st.isFile()) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
    } catch {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const ext = path.extname(resolved).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    const isHtml = ext === '.html' || ext === '.webmanifest' || path.basename(resolved) === 'sw.js';
    const headers = {
      'Content-Type': mime,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=300',
      ...extraHeaders,
    };

    const acceptEnc = String(req.headers['accept-encoding'] || '');
    if (COMPRESSIBLE_EXTS.has(ext) && acceptEnc.includes('gzip') && st.size > 256) {
      headers['Content-Encoding'] = 'gzip';
      headers['Vary'] = 'Accept-Encoding';
      res.writeHead(200, headers);
      fs.createReadStream(resolved).pipe(zlib.createGzip({ level: 6 })).pipe(res);
    } else {
      headers['Content-Length'] = st.size;
      res.writeHead(200, headers);
      if (req.method === 'HEAD') {
        res.end();
      } else {
        fs.createReadStream(resolved).pipe(res);
      }
    }
  };

  return http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = reqUrl.pathname;

    try {
      // 1. Health
      if (pathname === '/api/health' && req.method === 'GET') {
        return sendJson(res, 200, {
          ok: true,
          service: 'stlviewer-web',
          uptimeSec: Math.floor((Date.now() - startTime) / 1000),
          sharedCount: countShares(),
          libraryCount: getLibrary().length,
          tunnelUrl: readLatestTunnelUrl(tunnelLogPath),
        });
      }

      // 2. Access info (all ultra-easy URLs for QR & copy)
      if (pathname === '/api/access-info' && req.method === 'GET') {
        return sendJson(res, 200, {
          ok: true,
          serverMode: true,
          githubPages,
          publicTunnel: readLatestTunnelUrl(tunnelLogPath),
          lanShort: 'http://stl',
          lanAlt: 'http://stlviewer',
          lanDirect: `http://${lanIp}:${publicPort}`,
          tailscale: `http://${tailscaleIp}:${publicPort}`,
        });
      }

      // 3. Share upload: POST /api/share
      if (pathname === '/api/share' && req.method === 'POST') {
        const buf = await readRequestBody(req, maxShareBytes);
        const check = validateStlBytes(buf);
        if (!check.ok) {
          return sendJson(res, 415, { ok: false, error: 'Unsupported or invalid STL file' });
        }
        const name = sanitizeFilename(req.headers['x-filename'] || 'shared.stl');
        const id = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10);
        const stlPath = path.join(sharesDir, `${id}.stl`);
        const metaPath = path.join(sharesDir, `${id}.json`);
        const existed = fs.existsSync(stlPath);
        const now = Date.now();
        const meta = {
          id,
          name,
          bytes: buf.length,
          createdAt: now,
          expiresAt: now + shareTtlMs,
        };
        if (!existed) {
          fs.writeFileSync(stlPath, buf);
          fs.writeFileSync(metaPath, JSON.stringify(meta));
          pruneShares();
        } else if (!fs.existsSync(metaPath)) {
          fs.writeFileSync(metaPath, JSON.stringify(meta));
        } else {
          // Refresh expiry and keep original clean metadata
          try {
            const old = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            old.expiresAt = now + shareTtlMs;
            fs.writeFileSync(metaPath, JSON.stringify(old));
          } catch {}
        }
        return sendJson(res, existed ? 200 : 201, {
          ok: true,
          id,
          name,
          bytes: buf.length,
          sharePath: `/s/${id}`,
          rawPath: `/api/share/${id}`,
          expiresAt: meta.expiresAt,
        });
      }

      // 4. Share download: GET /api/share/:id
      const shareApiMatch = pathname.match(/^\/api\/share\/([a-f0-9]{8,16})$/);
      if (shareApiMatch && (req.method === 'GET' || req.method === 'HEAD')) {
        const id = shareApiMatch[1];
        const stlPath = path.join(sharesDir, `${id}.stl`);
        const metaPath = path.join(sharesDir, `${id}.json`);
        if (!fs.existsSync(stlPath)) {
          return sendJson(res, 404, { ok: false, error: 'Shared model not found or expired' });
        }
        let name = `${id}.stl`;
        try {
          name = sanitizeFilename(JSON.parse(fs.readFileSync(metaPath, 'utf8')).name);
        } catch {}
        const st = fs.statSync(stlPath);
        res.writeHead(200, {
          'Content-Type': 'model/stl',
          'Content-Length': st.size,
          'Content-Disposition': `inline; filename="${name}"`,
          'X-Model-Name': encodeURIComponent(name),
          'Cache-Control': 'public, max-age=3600',
          'X-Content-Type-Options': 'nosniff',
        });
        if (req.method === 'HEAD') return res.end();
        return fs.createReadStream(stlPath).pipe(res);
      }

      // 5. Pretty Share Page: GET /s/:id
      const sharePageMatch = pathname.match(/^\/s\/([a-f0-9]{8,16})$/);
      if (sharePageMatch && req.method === 'GET') {
        const id = sharePageMatch[1];
        const metaPath = path.join(sharesDir, `${id}.json`);
        let modelName = `${id}.stl`;
        if (fs.existsSync(metaPath)) {
          try {
            modelName = sanitizeFilename(JSON.parse(fs.readFileSync(metaPath, 'utf8')).name);
          } catch {}
        }
        const indexPath = path.join(docsDir, 'index.html');
        let html = fs.readFileSync(indexPath, 'utf8');
        const safeName = escapeHtml(modelName);
        const inject =
          `<base href="/" />` +
          `<meta name="stlviewer-share-id" content="${escapeHtml(id)}" />` +
          `<meta name="stlviewer-share-name" content="${safeName}" />` +
          `<meta property="og:title" content="${safeName} — STLViewer Web" />` +
          `<meta property="og:description" content="3D STL modelini tarayıcıda anında inceleyin." />`;
        html = html.replace('<head>', `<head>\n  ${inject}`);
        html = html.replace(/<title>[^<]*<\/title>/, `<title>${safeName} — STLViewer Web</title>`);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff',
        });
        return res.end(html);
      }

      // 6. Kasa STL Library list: GET /api/library
      if (pathname === '/api/library' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, items: getLibrary() });
      }

      // 7. Kasa STL Library file: GET /api/library/file?root=0&path=...
      if (pathname === '/api/library/file' && (req.method === 'GET' || req.method === 'HEAD')) {
        const rootIdx = Number(reqUrl.searchParams.get('root'));
        const rel = reqUrl.searchParams.get('path') || '';
        const entry = libraryDirs[rootIdx];
        if (!entry || !entry.dir || !rel || !/\.stl$/i.test(rel)) {
          return sendJson(res, 403, { ok: false, error: 'Forbidden path' });
        }
        const baseReal = fs.realpathSync(path.resolve(entry.dir));
        const candidate = path.resolve(baseReal, rel);
        if (!candidate.startsWith(baseReal + path.sep)) {
          return sendJson(res, 403, { ok: false, error: 'Path traversal blocked' });
        }
        if (!fs.existsSync(candidate)) {
          return sendJson(res, 404, { ok: false, error: 'File not found' });
        }
        const realFile = fs.realpathSync(candidate);
        if (!realFile.startsWith(baseReal + path.sep) || !/\.stl$/i.test(realFile)) {
          return sendJson(res, 403, { ok: false, error: 'Symlink escape blocked' });
        }
        const st = fs.statSync(realFile);
        const safeName = sanitizeFilename(path.basename(realFile));
        res.writeHead(200, {
          'Content-Type': 'model/stl',
          'Content-Length': st.size,
          'Content-Disposition': `inline; filename="${safeName}"`,
          'X-Model-Name': encodeURIComponent(safeName),
          'Cache-Control': 'public, max-age=60',
          'X-Content-Type-Options': 'nosniff',
        });
        if (req.method === 'HEAD') return res.end();
        return fs.createReadStream(realFile).pipe(res);
      }

      // 8. SSRF-Safe CORS Proxy: GET /api/proxy?url=...
      if (pathname === '/api/proxy' && req.method === 'GET') {
        const target = reqUrl.searchParams.get('url') || '';
        if (!target) return sendJson(res, 400, { ok: false, error: 'Missing url parameter' });
        const buf = await fetchPublicUrlSafe(target, maxShareBytes);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': buf.length,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        return res.end(buf);
      }

      // 9. Static files from /docs
      if (req.method === 'GET' || req.method === 'HEAD') {
        const cleanPath = decodeURIComponent(pathname);
        if (cleanPath === '/' || cleanPath === '') {
          return serveStaticFile(req, res, path.join(docsDir, 'index.html'));
        }
        const targetFile = path.join(docsDir, cleanPath.replace(/^\/+/, ''));
        if (fs.existsSync(targetFile) && fs.statSync(targetFile).isFile()) {
          return serveStaticFile(req, res, targetFile);
        }
        // Fallback to index.html for clean SPA routes without file extensions
        if (!path.extname(cleanPath)) {
          return serveStaticFile(req, res, path.join(docsDir, 'index.html'));
        }
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not Found');
      }

      res.writeHead(405);
      res.end('Method Not Allowed');
    } catch (err) {
      const code = err?.statusCode || 500;
      if (!res.headersSent) {
        sendJson(res, code, { ok: false, error: err?.message || 'Internal Server Error' });
      }
    }
  });
}

// Start standalone when invoked directly
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const port = Number(process.env.PORT || 8097);
  const libDirs = [];
  if (process.env.LIBRARY_DIRS) {
    for (const spec of process.env.LIBRARY_DIRS.split(',')) {
      const [label, dir] = spec.includes('=') ? spec.split('=') : [path.basename(spec), spec];
      if (dir && fs.existsSync(dir.trim())) {
        libDirs.push({ label: label.trim(), dir: dir.trim() });
      }
    }
  }
  const server = createAppServer({
    docsDir: process.env.DOCS_DIR || path.join(__dirname, '..', 'docs'),
    dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'server_data'),
    libraryDirs: libDirs,
    tunnelLogPath: process.env.TUNNEL_LOG_PATH || '/var/log/cloudflared.log',
    publicPort: port,
  });
  server.listen(port, '0.0.0.0', () => {
    console.log(`[stlviewer-web] listening on http://0.0.0.0:${port} (libs=${libDirs.length})`);
  });
}
