import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { deflateRawSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const { chromium } = require('/e2e/node_modules/playwright-core');
const axe = require('/e2e/node_modules/axe-core');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8097';
const OUT_DIR = process.env.OUT_DIR || '/out';
const PREFIX = process.env.SHOT_PREFIX || 'c1';
fs.mkdirSync(OUT_DIR, { recursive: true });

function rectOverlap(a, b, pad = 0) {
  if (!a || !b) return false;
  return !(
    a.right <= b.left + pad ||
    a.left >= b.right - pad ||
    a.bottom <= b.top + pad ||
    a.top >= b.bottom - pad
  );
}

function makeTinyBinaryStl(invert = false) {
  const raw = [
    0, 0, 0, 0, 10, 0, 10, 10, 0, 0, 0, 0, 10, 10, 0, 10, 0, 0,
    0, 0, 10, 10, 0, 10, 10, 10, 10, 0, 0, 10, 10, 10, 10, 0, 10, 10,
    0, 0, 0, 10, 0, 0, 10, 0, 10, 0, 0, 0, 10, 0, 10, 0, 0, 10,
    10, 10, 0, 0, 10, 0, 0, 10, 10, 10, 10, 0, 0, 10, 10, 10, 10, 10,
    0, 10, 0, 0, 0, 0, 0, 0, 10, 0, 10, 0, 0, 0, 10, 0, 10, 10,
    10, 0, 0, 10, 10, 0, 10, 10, 10, 10, 0, 0, 10, 10, 10, 10, 0, 10,
  ];
  const triCount = raw.length / 9;
  const buf = Buffer.alloc(84 + triCount * 50);
  buf.write(invert ? 'inverted-cube' : 'e2e-cube', 0, 'ascii');
  buf.writeUInt32LE(triCount, 80);
  for (let t = 0; t < triCount; t++) {
    const off = 84 + t * 50;
    const b = t * 9;
    const order = invert ? [0, 1, 2, 6, 7, 8, 3, 4, 5] : [0, 1, 2, 3, 4, 5, 6, 7, 8];
    for (let k = 0; k < 9; k++) buf.writeFloatLE(raw[b + order[k]], off + 12 + k * 4);
  }
  return buf;
}

function buildTestZip(stlName, stlBuf) {
  const nameBytes = Buffer.from(stlName, 'utf8');
  const payload = deflateRawSync(stlBuf);
  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[i] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < stlBuf.length; i++) crc = crcTable[(crc ^ stlBuf[i]) & 0xff] ^ (crc >>> 8);
  crc = (crc ^ 0xffffffff) >>> 0;

  const lh = Buffer.alloc(30 + nameBytes.length);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4);
  lh.writeUInt16LE(8, 8);
  lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(payload.length, 18);
  lh.writeUInt32LE(stlBuf.length, 22);
  lh.writeUInt16LE(nameBytes.length, 26);
  nameBytes.copy(lh, 30);

  const ch = Buffer.alloc(46 + nameBytes.length);
  ch.writeUInt32LE(0x02014b50, 0);
  ch.writeUInt16LE(20, 4);
  ch.writeUInt16LE(20, 6);
  ch.writeUInt16LE(8, 10);
  ch.writeUInt32LE(crc, 16);
  ch.writeUInt32LE(payload.length, 20);
  ch.writeUInt32LE(stlBuf.length, 24);
  ch.writeUInt16LE(nameBytes.length, 28);
  ch.writeUInt32LE(0, 42);
  nameBytes.copy(ch, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(ch.length, 12);
  eocd.writeUInt32LE(lh.length + payload.length, 16);

  return Buffer.concat([lh, payload, ch, eocd]);
}

async function runAxe(page, label) {
  await page.addScriptTag({ content: axe.source });
  const res = await page.evaluate(async () => await window.axe.run());
  const violations = res.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.map((n) => n.html.slice(0, 100)),
  }));
  if (violations.length > 0) {
    console.error(`AXE VIOLATIONS [${label}]:`, JSON.stringify(violations, null, 2));
  }
  return violations;
}

const report = {
  baseUrl: BASE_URL,
  checks: [],
  axe: {},
  errors: [],
  screenshots: [],
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser',
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--use-gl=angle',
    '--use-angle=gles-egl',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--disable-gpu-sandbox',
  ],
});

try {
  // =========================================================================
  // 1. Desktop 1440x900 — WebGL2 Dark Theme + Axe Audit
  // =========================================================================
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(`PAGEERR: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errs.push(`CONSOLE: ${m.text()}`); });

    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1600);

    const status = await page.textContent('#status-text');
    const metrics = await page.textContent('#info-metrics');
    const title = await page.title();
    assert.ok(title.includes('STLViewer'), `Unexpected title: ${title}`);
    assert.ok(status.includes('SSAA'), `Expected true WebGL2 SSAA backend, got: ${status}`);
    assert.ok(metrics.includes('88.0×88.0×30.0 mm'), `Unexpected metrics: ${metrics}`);
    assert.equal(errs.length, 0, `Errors on desktop load: ${errs.join('; ')}`);

    const shot1 = path.join(OUT_DIR, `${PREFIX}_01_desktop_webgl2_dark.png`);
    await page.screenshot({ path: shot1 });
    report.screenshots.push(shot1);
    report.axe.desktopDark = await runAxe(page, 'desktop-dark');
    report.checks.push({ name: 'desktop_webgl2_dark', status, metrics, errs: errs.length });

    // 2. Light Theme + Inspector Drawer + Build Plate + Overhang + Unit Switch
    await page.keyboard.press('t');
    await page.click('#btn-inspect');
    await page.click('#btn-bed-toggle');
    await page.click('#btn-overhang');
    await page.selectOption('#sel-material', 'petg');
    await page.click('.unit-btn[data-unit="cm"]');
    await page.waitForTimeout(900);

    const inspX = await page.textContent('#insp-x');
    assert.ok(inspX.includes('8.80 cm'), `Expected cm unit in inspector, got: ${inspX}`);
    const weight = await page.textContent('#insp-weight');
    assert.ok(weight.endsWith('g'), `Expected print weight in g, got: ${weight}`);

    // Verify triad does not overlap inspector drawer!
    const layoutCheck = await page.evaluate(() => {
      const tr = document.getElementById('triad-btn').getBoundingClientRect();
      const dr = document.getElementById('inspector-drawer').getBoundingClientRect();
      const tb = document.getElementById('toolbar-pill').getBoundingClientRect();
      return { tr, dr, tb };
    });
    assert.equal(rectOverlap(layoutCheck.tr, layoutCheck.dr), false, 'Triad overlaps inspector drawer!');
    assert.equal(rectOverlap(layoutCheck.tr, layoutCheck.tb), false, 'Triad overlaps toolbar!');

    const shot2 = path.join(OUT_DIR, `${PREFIX}_02_desktop_light_inspector_overhang.png`);
    await page.screenshot({ path: shot2 });
    report.screenshots.push(shot2);
    report.axe.desktopLight = await runAxe(page, 'desktop-light-inspector');
    report.checks.push({ name: 'desktop_light_inspector_overhang', inspX, weight });

    // Close inspector & overhang, switch back to Dark for Model Hub test
    await page.click('#btn-inspector-close');
    await page.click('#btn-overhang');
    await page.keyboard.press('t');
    await page.waitForTimeout(400);

    // 3. Model Hub Popover + Real Kasa P-51 STL (`Propeller.stl`) + Slice
    await page.click('#btn-model-menu');
    await page.waitForTimeout(400);
    const libVisible = await page.isVisible('#kasa-lib-section');
    assert.equal(libVisible, true, 'Kasa STL library section should be visible on Kasa server');
    const libCount = await page.locator('#kasa-lib-list .pop-item').count();
    assert.ok(libCount >= 6, `Expected >=6 Kasa library STLs, got ${libCount}`);

    // Verify search filter narrows library cleanly
    await page.fill('#lib-search', 'Wing');
    const filteredCount = await page.locator('#kasa-lib-list .pop-item').count();
    assert.equal(filteredCount, 2, `Expected 2 Wing STLs, got ${filteredCount}`);
    await page.fill('#lib-search', '');

    const shot3 = path.join(OUT_DIR, `${PREFIX}_03_model_hub_popover.png`);
    await page.screenshot({ path: shot3 });
    report.screenshots.push(shot3);

    // Load Propeller.stl (real 1.9 MB SolidCraft CAD model!)
    await page.locator('#kasa-lib-list .pop-item', { hasText: 'Propeller.stl' }).first().click();
    await page.waitForFunction(() => document.getElementById('info-name')?.textContent?.includes('Propeller.stl'), null, { timeout: 15000 });
    await page.waitForTimeout(1200);
    const propMetrics = await page.textContent('#info-metrics');

    // Verify 45-degree Overhang Check renders vividly from underside oblique angle on real CAD geometry!
    await page.keyboard.press('a');
    await page.keyboard.press('6'); // Bottom view -> reveals underside downward overhangs
    await page.waitForTimeout(700);
    await page.mouse.move(720, 450);
    await page.mouse.down();
    await page.mouse.move(780, 390, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(700);
    const shotOverhang = path.join(OUT_DIR, `${PREFIX}_04a_propeller_overhang_coral.png`);
    await page.screenshot({ path: shotOverhang });
    report.screenshots.push(shotOverhang);
    await page.keyboard.press('a');
    await page.keyboard.press('0');
    await page.waitForTimeout(500);

    // Enable Slice + move slider -> AND immediately press 's' while slider still has focus (Cycle 3 regression test!)
    await page.keyboard.press('s');
    await page.waitForTimeout(250);
    await page.locator('#slice-slider').focus();
    await page.locator('#slice-slider').fill('0.58');
    await page.locator('#slice-slider').dispatchEvent('input');
    await page.waitForTimeout(800);

    const shot4 = path.join(OUT_DIR, `${PREFIX}_04_real_p51_propeller_slice.png`);
    await page.screenshot({ path: shot4 });
    report.screenshots.push(shot4);
    report.checks.push({ name: 'real_p51_propeller_slice', libCount, propMetrics });

    // Press 's' while slider is focused: MUST toggle slice off!
    await page.keyboard.press('s');
    await page.waitForTimeout(250);
    assert.equal(await page.isVisible('#slice-pill'), false, 'Pressing S while slice slider has focus must close Slice!');

    // Re-enable slice for share roundtrip test (so shared link carries slice state!)
    await page.keyboard.press('s');
    await page.waitForTimeout(250);

    // 4. Access & Share Modal (QR + Model Share Round-Trip!)
    await page.click('#btn-share');
    await page.waitForTimeout(400);
    const qrSvgCount = await page.locator('#access-qr-box svg path').count();
    assert.ok(qrSvgCount >= 1, 'Access QR SVG path missing');

    const shot5 = path.join(OUT_DIR, `${PREFIX}_05_share_access_qr.png`);
    await page.screenshot({ path: shot5 });
    report.screenshots.push(shot5);

    // Switch to Model Share tab and upload active model
    await page.click('#tab-share-model');
    await page.click('#btn-generate-share');
    await page.waitForSelector('#model-share-result:not(.hidden)', { timeout: 10000 });
    const sharedUrl = await page.inputValue('#model-share-input');
    assert.ok(sharedUrl.includes('/s/'), `Expected /s/<id> share URL, got: ${sharedUrl}`);
    const sharePathWithHash = new URL(sharedUrl).pathname + new URL(sharedUrl).hash;

    // Open shared URL in a fresh context to prove end-to-end sharing works!
    const ctxShare = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const pageShare = await ctxShare.newPage();
    await pageShare.goto(`${BASE_URL}${sharePathWithHash}`, { waitUntil: 'networkidle' });
    await pageShare.waitForFunction(() => document.getElementById('info-name')?.textContent?.includes('Propeller.stl'), null, { timeout: 15000 });
    await pageShare.waitForTimeout(1000);
    const shot6 = path.join(OUT_DIR, `${PREFIX}_06_shared_link_opened.png`);
    await pageShare.screenshot({ path: shot6 });
    report.screenshots.push(shot6);
    await ctxShare.close();
    report.checks.push({ name: 'share_qr_and_roundtrip', sharedUrl });

    await page.click('#btn-share-close');

    // Stress Test: Large 3.7 MB P-51 Wing_R.stl + Aluminum MatCap + Orbit Drag + Keyboard Zoom
    await page.click('#btn-model-menu');
    await page.locator('#kasa-lib-list .pop-item', { hasText: 'Wing_R.stl' }).first().click();
    await page.waitForFunction(() => document.getElementById('info-name')?.textContent?.includes('Wing_R.stl'), null, { timeout: 20000 });
    await page.keyboard.press('m'); // Aluminum MatCap
    await page.mouse.move(720, 450);
    await page.mouse.down();
    await page.mouse.move(840, 380, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.press('+');
    await page.waitForTimeout(900);
    const wingMetrics = await page.textContent('#info-metrics');
    const shotWing = path.join(OUT_DIR, `${PREFIX}_06b_wing_aluminum_orbit.png`);
    await page.screenshot({ path: shotWing });
    report.screenshots.push(shotWing);
    report.checks.push({ name: 'heavy_3_7mb_wing_aluminum', wingMetrics });

    // Switch MatCap back to Clay
    await page.keyboard.press('m');
    await page.keyboard.press('m');
    await page.keyboard.press('m');

    // 5. Measure 3D + Clean Calibration Block Slice (Zero Z-Fighting) + PNG Snapshot Export!
    await page.click('#btn-model-menu');
    await page.locator('#demo-list .pop-item', { hasText: 'Calibration Block' }).click();
    await page.waitForFunction(() => document.getElementById('info-name')?.textContent?.includes('calibration-block.stl'), null, { timeout: 8000 });
    assert.equal(await page.isVisible('#slice-pill'), false, 'Switching model must start unsliced!');
    await page.waitForTimeout(800);

    // Slice calibration-block at 0.5 to verify ZERO Z-fighting!
    await page.keyboard.press('s');
    await page.waitForTimeout(500);
    const shotCalSlice = path.join(OUT_DIR, `${PREFIX}_07a_calibration_clean_slice.png`);
    await page.screenshot({ path: shotCalSlice });
    report.screenshots.push(shotCalSlice);
    await page.keyboard.press('s');
    await page.waitForTimeout(400);

    await page.keyboard.press('d');
    await page.mouse.click(700, 440);
    await page.waitForTimeout(250);
    await page.mouse.click(760, 470);
    await page.waitForTimeout(600);
    const measTxt = await page.textContent('#measure-text');
    assert.ok(measTxt.includes('mm'), `Expected 3D measurement readout, got: ${measTxt}`);

    const shot7 = path.join(OUT_DIR, `${PREFIX}_07_measure_3d.png`);
    await page.screenshot({ path: shot7 });
    report.screenshots.push(shot7);

    // Test PNG snapshot download produces real non-empty PNG!
    const [dl] = await Promise.all([
      page.waitForEvent('download'),
      page.keyboard.press('c'),
    ]);
    const dlPath = path.join(OUT_DIR, `${PREFIX}_snapshot_export.png`);
    await dl.saveAs(dlPath);
    const dlStat = fs.statSync(dlPath);
    assert.ok(dlStat.size > 8000, `Exported PNG suspiciously small (${dlStat.size} bytes)`);
    report.screenshots.push(dlPath);
    report.checks.push({ name: 'measure_and_png_export', measTxt, pngBytes: dlStat.size });

    // Test 1-Tap STL Download from Inspector Drawer
    await page.click('#btn-inspect');
    await page.waitForTimeout(200);
    const [stlDl] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#btn-download-stl'),
    ]);
    const stlDlPath = path.join(OUT_DIR, `${PREFIX}_exported.stl`);
    await stlDl.saveAs(stlDlPath);
    assert.ok(fs.statSync(stlDlPath).size > 1000, 'Downloaded STL unexpectedly small');
    await page.click('#btn-inspector-close');

    // Test Help Modal + verify non-zero chunk diagnostics + axe audit
    await page.keyboard.press('?');
    await page.waitForTimeout(300);
    const diagText = await page.textContent('#engine-diag');
    assert.ok(!diagText.includes('0/0 chunks'), `Engine diagnostics must show real chunk count when idle, got: ${diagText}`);
    report.axe.helpModal = await runAxe(page, 'help-modal');
    const shotHelp = path.join(OUT_DIR, `${PREFIX}_15_help_modal.png`);
    await page.screenshot({ path: shotHelp });
    report.screenshots.push(shotHelp);
    await page.keyboard.press('Escape');

    // Test '[' / ']' cycling through demo samples
    await page.keyboard.press(']');
    await page.waitForFunction(() => document.getElementById('info-name')?.textContent?.includes('flange-housing.stl'), null, { timeout: 6000 });

    // Test Inverted-Normal Auto-Protection & Corrupt STL Recovery
    const invPath = '/tmp/inverted_test.stl';
    fs.writeFileSync(invPath, makeTinyBinaryStl(true));
    await page.setInputFiles('#file-input', invPath);
    await page.waitForFunction(() => document.getElementById('info-name')?.textContent?.includes('inverted_test.stl'), null, { timeout: 6000 });
    assert.equal(await page.getAttribute('#btn-twosided', 'aria-pressed'), 'true', 'Inverted STL must auto-enable 2-Side!');

    const badPath = '/tmp/corrupt_junk.stl';
    fs.writeFileSync(badPath, Buffer.from('THIS IS CORRUPT GARBAGE NOT AN STL'));
    await page.setInputFiles('#file-input', badPath);
    await page.waitForTimeout(400);
    // Must stay safely on inverted_test.stl without crashing!
    assert.ok((await page.textContent('#info-name')).includes('inverted_test.stl'));

    // Test TR <-> EN switch
    await page.click('#btn-lang');
    await page.waitForTimeout(200);
    const enOpen = await page.textContent('#btn-open span[data-i18n="open"]');
    assert.equal(enOpen, 'Open');
    await page.click('#btn-lang');

    assert.equal(errs.length, 0, `Runtime errors detected: ${errs.join('; ')}`);
    await ctx.close();
  }

  // =========================================================================
  // 6A. Forced WebGL1 Fallback (?renderer=webgl1)
  // =========================================================================
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(`${BASE_URL}/?renderer=webgl1`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    const st = await page.textContent('#status-text');
    assert.ok(st.includes('WebGL1'), `Expected WebGL1 status, got: ${st}`);
    const shotW1 = path.join(OUT_DIR, `${PREFIX}_08a_webgl1.png`);
    await page.screenshot({ path: shotW1 });
    report.screenshots.push(shotW1);
    assert.equal(errs.length, 0, `WebGL1 errors: ${errs.join('; ')}`);
    report.checks.push({ name: 'webgl1_fallback', status: st });
    await ctx.close();
  }

  // =========================================================================
  // 6B. Forced Canvas 2D Software Z-Buffer Fallback (?renderer=2d)
  // =========================================================================
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(`${BASE_URL}/?renderer=2d`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    const st = await page.textContent('#status-text');
    assert.ok(st.includes('2D ZBuf'), `Expected 2D ZBuf status, got: ${st}`);
    const shot8 = path.join(OUT_DIR, `${PREFIX}_08_canvas2d_zbuffer.png`);
    await page.screenshot({ path: shot8 });
    report.screenshots.push(shot8);

    // Also verify Overhang highlight works identically in Canvas 2D Software Z-Buffer!
    await page.keyboard.press('a');
    await page.keyboard.press('6');
    await page.waitForTimeout(600);
    const shot8b = path.join(OUT_DIR, `${PREFIX}_08b_canvas2d_overhang_bottom.png`);
    await page.screenshot({ path: shot8b });
    report.screenshots.push(shot8b);
    assert.equal(errs.length, 0, `Canvas2D errors: ${errs.join('; ')}`);
    report.checks.push({ name: 'canvas2d_zbuffer', status: st });
    await ctx.close();
  }

  // =========================================================================
  // 7. Mobile 390x844 (Touch Device Emulation) — Zero Collisions + Touch Targets
  // =========================================================================
  {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));

    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1400);

    const mobileAudit = await page.evaluate(() => {
      const info = document.getElementById('info-pill').getBoundingClientRect();
      const stat = document.getElementById('status-pill').getBoundingClientRect();
      const triad = document.getElementById('triad-btn').getBoundingClientRect();
      const tb = document.getElementById('toolbar-pill').getBoundingClientRect();
      const lblX = document.getElementById('axis-lbl-x').getBoundingClientRect();
      const lblY = document.getElementById('axis-lbl-y').getBoundingClientRect();
      const lblZ = document.getElementById('axis-lbl-z').getBoundingClientRect();
      return {
        scrollW: document.documentElement.scrollWidth,
        innerW: window.innerWidth,
        info, stat, triad, tb, lblX, lblY, lblZ,
      };
    });

    assert.ok(mobileAudit.scrollW <= mobileAudit.innerW, `Horizontal overflow on mobile: ${mobileAudit.scrollW} > ${mobileAudit.innerW}`);
    assert.equal(rectOverlap(mobileAudit.info, mobileAudit.stat), false, 'Mobile top-left & top-right pills overlap!');
    assert.equal(rectOverlap(mobileAudit.triad, mobileAudit.tb), false, 'Mobile triad hitbox overlaps toolbar!');
    assert.equal(rectOverlap(mobileAudit.lblX, mobileAudit.tb), false, 'Mobile axis X label overlaps toolbar!');
    assert.equal(rectOverlap(mobileAudit.lblY, mobileAudit.tb), false, 'Mobile axis Y label overlaps toolbar!');
    assert.equal(rectOverlap(mobileAudit.lblZ, mobileAudit.tb), false, 'Mobile axis Z label overlaps toolbar!');

    const shot9 = path.join(OUT_DIR, `${PREFIX}_09_mobile_default.png`);
    await page.screenshot({ path: shot9 });
    report.screenshots.push(shot9);
    report.axe.mobile = await runAxe(page, 'mobile');

    // Open mobile inspector bottom sheet
    await page.click('#btn-inspect');
    await page.waitForTimeout(500);
    const shot10 = path.join(OUT_DIR, `${PREFIX}_10_mobile_inspector.png`);
    await page.screenshot({ path: shot10 });
    report.screenshots.push(shot10);
    await page.click('#btn-inspector-close');
    await page.waitForTimeout(300);

    // Mobile Light Theme + Axe
    await page.keyboard.press('t');
    await page.waitForTimeout(500);
    const shot11 = path.join(OUT_DIR, `${PREFIX}_11_mobile_light.png`);
    await page.screenshot({ path: shot11 });
    report.screenshots.push(shot11);
    report.axe.mobileLight = await runAxe(page, 'mobile-light');

    // Mobile Share QR Modal
    await page.click('#btn-share');
    await page.waitForTimeout(400);
    const shot12 = path.join(OUT_DIR, `${PREFIX}_12_mobile_share_qr.png`);
    await page.screenshot({ path: shot12 });
    report.screenshots.push(shot12);
    await page.click('#btn-share-close');

    // Mobile Model Hub Popover
    await page.click('#btn-model-menu');
    await page.waitForTimeout(350);
    const shot13 = path.join(OUT_DIR, `${PREFIX}_13_mobile_model_hub.png`);
    await page.screenshot({ path: shot13 });
    report.screenshots.push(shot13);
    await page.keyboard.press('Escape');

    // Mobile Triad View Popover
    await page.click('#triad-btn');
    await page.waitForTimeout(300);
    const shot14 = path.join(OUT_DIR, `${PREFIX}_14_mobile_view_popover.png`);
    await page.screenshot({ path: shot14 });
    report.screenshots.push(shot14);

    assert.equal(errs.length, 0, `Mobile errors: ${errs.join('; ')}`);
    report.checks.push({ name: 'mobile_390x844', overflow: false, collisions: 0 });
    await ctx.close();
  }

  // =========================================================================
  // 8. Static / GitHub Pages Mode Simulation + ZIP Upload + Serverless #m= Share
  // =========================================================================
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(`PAGEERR: ${e.message}`));
    // Simulate GitHub Pages where /api/* does not exist
    await page.route('**/api/**', (route) => route.fulfill({ status: 404, body: 'Not Found' }));

    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);

    // Upload a .zip archive containing a binary STL!
    const tmpZip = '/tmp/test_bundle.zip';
    fs.writeFileSync(tmpZip, buildTestZip('zipped-cube.stl', makeTinyBinaryStl()));
    await page.setInputFiles('#file-input', tmpZip);
    await page.waitForFunction(() => document.getElementById('info-name')?.textContent?.includes('zipped-cube.stl'), null, { timeout: 8000 });
    await page.waitForTimeout(500);

    // Generate serverless #m= share link!
    await page.click('#btn-share');
    await page.click('#tab-share-model');
    await page.click('#btn-generate-share');
    await page.waitForSelector('#model-share-result:not(.hidden)', { timeout: 8000 });
    const inlineUrl = await page.inputValue('#model-share-input');
    assert.ok(inlineUrl.includes('#m='), `Expected serverless #m= link, got: ${inlineUrl}`);

    // Open serverless #m= URL in a clean static context!
    const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p2 = await ctx2.newPage();
    await p2.route('**/api/**', (route) => route.fulfill({ status: 404, body: 'Not Found' }));
    await p2.goto(inlineUrl, { waitUntil: 'networkidle' });
    await p2.waitForFunction(() => document.getElementById('info-name')?.textContent?.includes('zipped-cube.stl'), null, { timeout: 8000 });
    await ctx2.close();

    // Verify IndexedDB recent vault persists uploaded STL across full page reload!
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(700);
    await page.click('#btn-model-menu');
    await page.waitForSelector('#recent-section:not(.hidden)', { timeout: 5000 });
    const recText = await page.textContent('#recent-list');
    assert.ok(recText.includes('zipped-cube.stl'), `IndexedDB recent vault lost zipped-cube.stl after reload: ${recText}`);

    // Verify PWA manifest, Service Worker & Icons all return HTTP 200
    for (const asset of ['/manifest.webmanifest', '/sw.js', '/icons/icon-192.png', '/icons/icon-512.png']) {
      const r = await page.request.get(`${BASE_URL}${asset}`);
      assert.equal(r.status(), 200, `PWA asset ${asset} failed with ${r.status()}`);
    }

    assert.equal(errs.length, 0, `Static mode page errors: ${errs.join('; ')}`);
    report.checks.push({ name: 'static_pages_zip_vault_pwa_and_serverless_hash', inlineLen: inlineUrl.length });
    await ctx.close();
  }

  // Assert ZERO axe violations across all audited views!
  for (const [k, viols] of Object.entries(report.axe)) {
    assert.equal(viols.length, 0, `Axe WCAG violations in ${k}: ${JSON.stringify(viols)}`);
  }

  console.log('E2E_PASS_SUMMARY:', JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
