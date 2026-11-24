# STLViewer Web — Design Specification

**Date:** 2026-11-24
**Lineage:** Forked from `meucak/stlviewer` (preserving commit history)
**Mode:** Advanced Mode (Principal Engineer + Apple HIG + Superpowers TDD/Verification)

## 1. Intent & Why

Transform `stlviewer` into an ultra-accessible, zero-friction, web-first 3D STL inspection platform reachable from any desktop, laptop, or phone in seconds — whether on LAN, Tailscale, public internet (Cloudflare Tunnel), or offline/serverless (GitHub Pages PWA).

## 2. Goals, Non-Goals & Anti-Goals

### Goals
- **Universal Instant Access:**
  - 7/24 Serverless HTTPS PWA on GitHub Pages (`https://meucak.github.io/stlviewer-web/`).
  - Self-hosted Docker service (`stlviewer-web`, Port `8097`) + Cloudflare Quick Tunnel (`stlviewer-web-tunnel`) for public HTTPS sharing.
  - Zero-port LAN/Tailscale short URLs via Kasa Nginx + dnsmasq (`http://stl`, `http://stl.lan`, `http://stl.local`, `http://stlviewer`, `http://stlviewer.lan`, `http://stlviewer.local`).
  - Installable offline PWA with Service Worker, `.stl` File Handling API (`file_handlers`), and Android Web Share Target (`share_target`).
  - Offline pure-JS SVG QR Code + Share Sheet for 1-scan device handoff (both app access and exact model + camera state links).
- **Effortless File Opening (6 Paths):**
  - Drag & Drop `.stl` or `.zip` archives anywhere.
  - Mobile-safe File Picker (`accept=".stl,.STL,.zip,model/stl,application/sla,application/octet-stream"`).
  - Paste (`Ctrl+V`) `.stl` files, ASCII STL text, or URLs (with smart GitHub `blob` -> `raw` conversion).
  - `?url=` parameter + SSRF-safe server CORS proxy (`/api/proxy`) when backed by Kasa.
  - Persistent local Recent Models Vault (IndexedDB, up to 15 models / 64 MB LRU).
  - Read-only Kasa STL Library browser (`/api/library`) surfacing local CAD STLs in 1 tap.
- **Zero-Defect 3D Rendering Across All Hardware:**
  - Fix inverted revolution winding in `demo_models.js` (`addWasherStack`) so all built-in CAD parts have outward normals and positive signed volume.
  - Upgrade `RendererCanvas2D` to a true pixel-exact scanline barycentric Z-buffer (eliminating Painter's sort artifacts and triangle seams).
  - Keep WebGL2 (16× Halton SSAA, 8-byte UNORM16, `dFdx/dFdy` flat normals, 1×1 FBO depth pick, analytic `fwidth()` grid, 0% idle) and WebGL1 tiers rock-solid.
  - Add true world-space 45° Overhang Check (3D-print support analyzer) across all 3 rendering tiers.
  - Sync 3D Axis Triad coordinates dynamically with `#triad-btn.getBoundingClientRect()` to prevent any viewport collision.
- **Precision CAD Inspection & Apple HIG Craft:**
  - Collapsible Inspector Drawer: `mm/cm/in` unit toggle, Bounding Box, Volume, Area, Mesh Health (degenerate tris, inverted normal warning), 3D Print Weight/Filament Estimator (PLA/PETG/ABS/ASA/TPU/Resin + infill %), Build Plate reference (`220×220` / `256×256` mm), PNG Snapshot Export (`C`), Auto-Turntable (`V`).
  - Bilingual `TR / EN` instant switcher.
  - Adaptive **Obsidian Studio** (Dark) & **Alabaster Drafting** (Light) themes; zero `axe-core` WCAG AA violations; `44×44px` touch targets on coarse pointers.

### Non-Goals
- Full CAD mesh editing/boolean sculpting (this is an inspection & sharing platform).
- User accounts, login walls, or external cloud storage dependencies.
- External npm/CDN runtime dependencies on the frontend (must remain 100% self-contained ES modules).

### Anti-Goals
- Never break offline/static GitHub Pages compatibility when Kasa backend is unreachable.
- Never show generic purple-glow AI-slop cards, cluttered sidebars blocking the 3D viewport, or overlapping mobile controls.
- Never pollute the Debian host with Node/npm/Playwright (all runtime & tests execute inside Docker; only Nginx vhost and dnsmasq host-infra rules touch host Debian per System Rule 1 & 2).

## 3. Architecture & Approaches Considered

1. **Pure Static GitHub Pages Only** — Zero maintenance, works 24/7, but cannot share large multi-MB STL files via short QR link, cannot bypass CORS for arbitrary URLs, and cannot browse Kasa's local CAD library.
2. **Backend-Required SPA (React/Vite + DB)** — Rich server features, but breaks GitHub Pages standalone offline access and adds heavy build/runtime bloat.
3. **Dual-Mode Zero-Dependency Progressive Architecture (Selected):**
   - `/docs` is a 100% pure, zero-build, zero-CDN ES Module PWA that runs identically on GitHub Pages (serverless mode, with IndexedDB vault + `#m=` gzipped tiny-STL URL sharing + `#v=` camera links + offline QR) AND automatically upgrades when served from Kasa Docker (`server/server.mjs`) by probing `/api/access-info` to unlock `/api/share` (up to 50 MB short links + QR), `/api/library` (read-only Kasa STLs), `/api/proxy` (SSRF-safe CORS proxy), and live Cloudflare Tunnel URL discovery!

## 4. Constraints
- Frontend: Zero external dependencies, zero build step, ES2022 modules in `/docs`.
- Backend: Zero external npm dependencies (Node.js 22 standard library only) in `/server/server.mjs`, `mem_limit: 128m`.
- Security: SSRF IP-range blocklist on `/api/proxy`; strict canonical `path.resolve` containment + `.stl` extension whitelist on `/api/library`; HTML escaping on injected OG tags; 50 MB upload cap + TTL/quota pruning on `/api/share`.
- Accessibility: 0 `axe-core` WCAG 2.0/2.1 AA violations across Dark/Light & Desktop/Mobile.
- Original repo `/home/kasa/apps/stlviewer` remains untouched; new repo pushed as `meucak/stlviewer-web` with GitHub Pages enabled on `/docs`.
