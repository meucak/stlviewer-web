# STLViewer Web

> **Anında erişilebilir, sıfır bağımlılıklı, çevrimdışı çalışan 3D STL görüntüleyici, baskı analiz ve paylaşım platformu**  
> *(Forked from [`meucak/stlviewer`](https://github.com/meucak/stlviewer) with full upstream git history)*

**STLViewer Web**, `stlviewer` motorunun yüksek verimli mimarisini (**8-byte UNORM16 köşe kuantalaması**, **off-thread Web Worker STL ayrıştırma**, **0-byte `dFdx/dFdy` yüzey normalleri**, **4096-üçgen frustum + normal-koni budama**, **16× Halton SSAA** ve **%0.0 boşta CPU/GPU**) herkesin tarayıcıdan, telefondan veya yerel ağdan saniyeler içinde açabileceği eksiksiz bir **çift modlu Web & PWA platformuna** dönüştürür.

---

## 🌍 Anında Erişim Yolları

| Kanal | Adres | Özellik |
|---|---|---|
| **7/24 Küresel PWA (GitHub Pages)** | <https://meucak.github.io/stlviewer-web/> | Sunucu gerektirmez; Kasa kapalıyken dahi tam çevrimdışı çalışır |
| **Yerel Ağ Kısa Adres (Kasa LAN)** | `http://stl` · `http://stl.lan` · `http://stlviewer` | Port numarası yazmadan doğrudan erişim + Kasa STL Arşivi |
| **Doğrudan LAN / Tailscale** | `http://192.168.1.100:8097` · `http://100.69.155.110:8097` | Docker konteyneri doğrudan erişim |
| **Genel İnternet (Cloudflare Tunnel)** | Uygulama içi **Paylaş (K)** → **Cihazdan Aç (QR)** | Kasa açıkken otomatik canlı `https://*.trycloudflare.com` + QR kod |
| **Tek Tık OS Başlatıcıları** | `launchers/` (`stlviewer-web.desktop`, `.sh`, `.bat`) | En hızlı ulaşılabilir adresi otomatik bulup tarayıcıda açar |

---

## ✨ Öne Çıkan Özellikler

### 🚀 6 Farklı Yoldan Sıfır Sürtünmeli Dosya Açma
1. **Sürükle & Bırak (`.stl` ve `.zip`):** Tekli/çoklu `.stl` veya Thingiverse/Printables `.zip` arşivlerini doğrudan pencereye bırakın; sıfır bağımlılıklı client-side ZIP çözücü tüm `.stl` dosyalarını otomatik çıkarır.
2. **Mobil Uyumlu Dosya Seçici (`O`):** Android/iOS seçicilerinde `.stl` dosyalarının grileşmesini engelleyen geniş MIME + uzantı desteği.
3. **Pano Yapıştırma (`Ctrl+V`):** Herhangi bir `.stl` dosyasını, GitHub/Dropbox/doğrudan URL’yi veya ham ASCII STL metnini doğrudan sayfaya yapıştırın.
4. **URL’den Yükleme (`L` / `?url=...`):** GitHub `blob` bağlantılarını otomatik `raw.githubusercontent.com`’a çevirir; Kasa sunucusunda SSRF-korumalı `/api/proxy` ile CORS engellerini aşar.
5. **Kasa STL Arşivi (`/api/library`):** Kasa üzerinde salt-okunur bağlanan CAD dizinlerindeki `.stl` modellerini arama filtresiyle tek tıkla açar.
6. **Kalıcı Çevrimdışı Kasa (IndexedDB Vault):** Son açılan 15 yerel model (64 MB LRU bütçesi) sayfa yenileme ve çevrimdışı kullanımda korunur.

### 📐 3 Katmanlı Hata Korumalı 3D Motor & Baskı Analizi
- **3 Katmanlı Render Otomasyonu:** **WebGL2** (16× Halton SSAA + `RGBA16F` + 1×1 FBO GPU depth picking) → **WebGL1** (GLSL ES 1.00 tam precision uyumlu) → **Piksel-Hassas Yazılım Z-Buffer Canvas 2D** (sıfır sıralama hatası, sıfır üçgen aralığı).
- **45° Sarkma / Destek Analizi (`A`):** Dünya uzayı normalleriyle 45° üzeri sarkmaları gerçek zamanlı mercan rengiyle vurgular (tüm 3 render katmanında).
- **Model & 3D Baskı İnceleme Çekmecesi (`N`):** `mm / cm / in` birim dönüşümü, hacim/alan, mesh sağlığı (ters normal otomatik `Çift Yüz` koruması + bozuk üçgen sayımı), **PLA / PETG / ABS / ASA / TPU / SLA Resin** doluluk bazlı ağırlık & filament hesabı ve **180³–300³ mm Baskı Tablası** 3D çerçevesi.
- **Kesit (`S`), 3D Ölçüm (`D`), PNG Ekran Görüntüsü (`C`), Tek Tık STL İndirme ve Otomatik Döndürme (`V`).**

### 📱 Çevrimdışı PWA & Tek Taramada Cihaz Aktarımı
- **Çevrimdışı ISO/IEC 18004 Vektör QR Üretici:** Harici API çağırmadan tarayıcıda SVG QR üretir.
- **Model Paylaşım Bağlantısı (`K`):** Kasa sunucusunda SHA-256 tekilleştirmeli `/s/<id>` kısa bağlantısı + kamera/kesit durumu (`#v=...`) üretir (50 MB’a kadar, 7 gün TTL); GitHub Pages statik modunda küçük modelleri (`≤120 KB`) doğrudan `#m=...` gzip hash bağlantısına gömer.
- **PWA Kurulumu:** Service Worker çevrimdışı önbelleği, `.stl`/`.zip` `file_handlers` ve Android `share_target` desteği.
- **Apple HIG & Erişilebilirlik:** *Obsidian Studio* (Koyu) ve *Alabaster Drafting* (Açık) temaları, anlık `TR / EN` dil geçişi, mobil `44×44px` dokunma hedefleri ve **0 `axe-core` WCAG AA ihlali**.

---

## 🐳 Docker ile Çalıştırma (Kasa / Self-Hosted)

```bash
docker compose up -d --build
# Yerel:  http://127.0.0.1:8097  (veya http://stl)
# Sağlık: curl http://127.0.0.1:8097/api/health
```

`docker-compose.yml` dosyası izole `stlviewer-web` (Node.js 22 Alpine, sıfır npm bağımlılığı, 128 MB RAM sınırı) ve `stlviewer-web-tunnel` (`cloudflare/cloudflared`) servislerini birlikte ayağa kaldırır.

---

## 🧪 Test & Doğrulama Paketi

```bash
# 19 Birim + Sunucu Güvenlik/Entegrasyon Testi (SSRF, Path Traversal, Z-Buffer, ZIP, QR, Winding)
docker run --rm -v "$PWD:/w" -w /w node:22-alpine \
  node --test tests/web/test_faset_web.mjs tests/web/test_core_upgrades.mjs tests/server/test_server.mjs

# Gerçek Chromium + Mesa WebGL2/WebGL1/2D + axe-core WCAG AA E2E Paketi
docker build -f Dockerfile.test -t stlviewer-web-test:latest .
docker run --rm --network host -e LIBGL_ALWAYS_SOFTWARE=1 -e GALLIUM_DRIVER=llvmpipe \
  -v "$PWD:/app:ro" -v /tmp/stlviewer-shots:/out \
  stlviewer-web-test:latest node /app/tests/e2e/run_e2e.mjs
```
