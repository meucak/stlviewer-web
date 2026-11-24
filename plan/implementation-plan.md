# STLViewer Web Implementation Plan

**Goal:** Deliver a dual-mode (GitHub Pages + Kasa Docker/Tunnel/LAN) zero-dependency 3D STL Web Platform with fixed 3D rendering, scanline Z-buffer Canvas2D fallback, ZIP/URL/paste/vault/library loading, instant QR & model sharing, 3D print inspection, bilingual Apple HIG UI, and multi-cycle Playwright visual/functional verification.

**Architecture:** Pure ES Module PWA in `docs/` + zero-dependency Node.js 22 server in `server/server.mjs` + Docker Compose (`stlviewer-web` Port 8097 + `cloudflared` sidecar) + Kasa Nginx/dnsmasq short domains (`http://stl`).

**Tech Stack:** ES2022, WebGL2 / WebGL1 / Software Z-Buffer Canvas2D, Web Worker, IndexedDB, Service Worker, Node.js 22, Docker Compose, Cloudflare Quick Tunnel, Playwright + Chromium + axe-core.

**Spec:** `plan/design-spec.md`

## Global Constraints
- Zero frontend npm/CDN dependencies; `/docs` runs cleanly on GitHub Pages without any backend.
- Zero backend npm dependencies; `server/server.mjs` uses Node 22 built-ins only.
- All automated tests (unit + API + Playwright Chromium E2E + axe-core) run inside Docker (`stlviewer-web-test:latest`).
- Zero regressions on existing 8 core math/camera/parser/culling/matcap/picking/canvas2d tests.

## Review Focus (Failure Modes & Edge Cases Pinned by Tests)
1. **Inside-out demo meshes & inverted STLs:** Revolution profiles must have strictly outward normals and positive signed volume; parser detects inverted/degenerate triangles without crashing.
2. **Mobile viewport collisions & narrow screens (`390×844`):** Triad, top pills, bottom dock, sub-pills, and drawers must never overlap or clip off-screen unexpectedly.
3. **WebGL blank PNG snapshot (`preserveDrawingBuffer: false`):** Snapshot export must render synchronously inside the same microtask before `toBlob` / `toDataURL` so exported PNGs contain actual model pixels, never solid black.
4. **SSRF & path traversal on Kasa backend:** `/api/proxy` must reject private/loopback/link-local IPs (`127.0.0.1`, `192.168.*`, `10.*`, `169.254.169.254`, `::1`, `localhost`) and non-http schemes; `/api/library/file` must reject `../` traversal and non-`.stl` files.
5. **Graceful static fallback (GitHub Pages mode):** When `/api/*` returns 404/network error, UI seamlessly hides Kasa-only library, uses serverless `#m=` / `#v=` sharing + GitHub Pages QR, and logs zero uncaught console errors.

---

### Task 1: Test Harness Image (`Dockerfile.test`)
- Create `Dockerfile.test` extending Node 22 Alpine with Chromium + Mesa Gallium/GL/EGL/Swrast + `playwright-core` + `axe-core` so E2E tests verify WebGL2, WebGL1, and Canvas 2D in real headless Chromium.
- Build `stlviewer-web-test:latest` and verify WebGL2 availability.

### Task 2: 3D Core Fixes & New Pure-JS Modules (TDD)
- Fix `docs/js/demo_models.js` `addWasherStack` winding & add outward-normal/signed-volume tests.
- Enhance `docs/js/stl_parser.js` with `degenerateTris`, `signedVolumeMm3`, `headerText`, trailing-padding tolerance, and ASCII robustness.
- Upgrade `docs/js/renderer_canvas2d.js` to pixel-exact Scanline Barycentric Z-Buffer (`ImageData` + `Float32Array` depth) with overhang highlight, dynamic triad position, zero seams, zero sorting glitches.
- Upgrade `docs/js/renderer.js` and `docs/js/renderer_webgl1.js` with dynamic `triadCenterCss` sync and world-space 45° Overhang Check + optional 3D printer Build Plate outline.
- Create tested pure-JS modules:
  - `docs/js/qr_encoder.js` (ISO/IEC 18004 SVG QR up to Version 16)
  - `docs/js/zip_stl.js` (Zero-dep `.zip` STL extractor)
  - `docs/js/print_calc.js` (Material weight/length/unit conversion/bed fit)
  - `docs/js/share_state.js` (Camera hash `#v=`, gzipped inline model `#m=`, smart URL normalizer)
  - `docs/js/i18n.js` (TR/EN localization dictionary + formatter)
  - `docs/js/vault.js` (IndexedDB recent models store with LRU budget)

### Task 3: Kasa Backend, Docker Compose, Tunnel & Host LAN Short URLs (TDD)
- Write comprehensive API unit/integration tests (`tests/server/test_server.mjs`) covering `/api/health`, `/api/access-info`, `/api/share` upload/download/dedup/invalid-STL/oversize, `/s/:id` OG injection, `/api/library` listing & traversal blocks, `/api/proxy` SSRF blocks.
- Implement `server/server.mjs`, `Dockerfile`, `docker-compose.yml`, and quick launchers (`launchers/stlviewer-web.desktop`, `.sh`, `.bat`).
- Configure Kasa host Nginx (`/etc/nginx/sites-available/local-apps.conf`) and dnsmasq (`/etc/dnsmasq.d/stlviewer-lan.conf`) for `http://stl`, `http://stl.lan`, `http://stl.local`, `http://stlviewer`, `http://stlviewer.lan`, `http://stlviewer.local`.

### Task 4: Ultra-Accessible PWA, HIG UI & App Integration
- Create `docs/manifest.webmanifest` (`file_handlers`, `share_target`, icons), `docs/sw.js` (network-first app shell caching, offline support), and crisp vector+PNG icons (`docs/icons/`).
- Rebuild `docs/index.html`, `docs/style.css`, and `docs/js/app.js` with semantic landmarks, Apple HIG Obsidian Studio / Alabaster Drafting design, Model Hub Popover (Open/URL/Kasa Library/Recents/Samples), Collapsible Inspector Drawer (Dimensions, Units, Print Estimator, Mesh Health, Overhangs, Build Plate, Turntable, Snapshot PNG), Access & Share Modal (QR tabs, 1-click upload share link, Copy Link, Install PWA), responsive mobile dock with zero collisions, and TR/EN toggle.

### Task 5: Marathon Open → Test → Screenshot → Inspect → Fix Cycles
- Cycle 1: Run full unit + server tests + Playwright E2E across Desktop (1440×900, 1280×800), Mobile (390×844), Dark & Light themes, WebGL2 & Canvas2D forced fallback, real P-51 CAD STLs (`Wing_R.stl`, `Propeller.stl`, `Fuselage_Front.stl`), ZIP extraction, Share Link round-trip, QR render, Measure, Slice, Overhangs, PNG export, and `axe-core` audit. Visually inspect every screenshot.
- Cycle 2–5+: Log every visual, ergonomic, contrast, performance, edge-case, or mobile flaw discovered; write regression tests; fix surgically; re-run full verification and re-inspect screenshots until spotless!

### Task 6: Delivery — GitHub Fork (`meucak/stlviewer-web`), GitHub Pages, Kasa Ortak & Registry
- Update `README.md` with clear architecture, screenshots/feature summary, and all access URLs.
- Push to new GitHub repository `meucak/stlviewer-web`, enable GitHub Pages on `main:/docs`, verify live `https://meucak.github.io/stlviewer-web/` in Playwright!
- Copy final clean project to `/home/kasa/Depo/agy/apps/stlviewer-web/` and update `/home/kasa/Depo/agy/apps_list.txt`.
