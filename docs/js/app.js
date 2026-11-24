import { vSub, vLen } from './math3d.js';
import { Camera, ViewPreset } from './camera.js';
import { MatcapKind, matcapName } from './matcap.js';
import { parseStlBuffer } from './stl_parser.js';
import { DEMO_MODELS, generateDemoStl } from './demo_models.js';
import { Renderer } from './renderer.js';
import { RendererWebGL1 } from './renderer_webgl1.js';
import { RendererCanvas2D } from './renderer_canvas2d.js';
import { renderQrSvg } from './qr_encoder.js';
import { extractStlsFromZip } from './zip_stl.js';
import {
  MATERIALS,
  BUILD_PLATES,
  estimatePrint,
  formatDim,
  formatVolume,
  formatArea,
  checkBedFit,
} from './print_calc.js';
import {
  normalizeStlUrl,
  encodeViewHash,
  decodeViewHash,
  encodeInlineModel,
  decodeInlineModel,
} from './share_state.js';
import { detectDefaultLang, createTranslator } from './i18n.js';
import {
  listRecentModels,
  getRecentModelBuffer,
  saveRecentModel,
  deleteRecentModel,
  clearRecentModels,
} from './vault.js';

const $ = (id) => document.getElementById(id);

const GITHUB_PAGES_FALLBACK = 'https://meucak.github.io/stlviewer-web/';

function formatCount(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return `${n}`;
}

function formatBytes(b) {
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(2)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
}

const isLowSpecDevice =
  (typeof navigator !== 'undefined' && navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) ||
  (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
  (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

const state = {
  lang: detectDefaultLang(),
  darkTheme: true,
  matcap: MatcapKind.Clay,
  wireframe: false,
  xray: false,
  overhang: false,
  twoSided: false,
  showGrid: true,
  showBed: false,
  bedId: '220',
  bedSize: BUILD_PLATES[0],
  turntable: false,
  showHud: true,
  showInspector: false,
  showHelp: false,
  showShare: false,
  showUrlModal: false,
  ecoMode: !!isLowSpecDevice,

  unit: 'mm',
  materialId: 'pla',
  infillPct: 20,

  sliceEnabled: false,
  sliceAxis: 2,
  sliceFlip: false,
  sliceT: 0.5,

  measureMode: false,
  measureHasA: false,
  measureHasB: false,
  measureA: { x: 0, y: 0, z: 0 },
  measureB: { x: 0, y: 0, z: 0 },

  activeModelKey: 'demo:flange-housing',
  activeSourceUrl: null,
  loadedFiles: [], // { name, buffer? , file? }
  loadedIndex: -1,
  recentModels: [],
  kasaLibrary: [],

  serverMode: false,
  accessInfo: null,
  selectedAccessKey: 'current',
  shareTab: 'access',

  triadCenterCss: null,
};

let t = createTranslator(state.lang);
let currentMesh = null;
let currentRawBuffer = null; // Kept for instant upload/share without re-reading file
let lastStats = null;
let cam = new Camera();
let renderer = null;
let worker = null;
let workerReady = false;
let parseSeq = 0;
let rafId = 0;
let lastAnimTime = 0;
let statusTimer = 0;
let transientStatus = '';
let deferredInstallPrompt = null;

let canvas = $('gl-canvas');

function getEffectiveDpr() {
  const raw = window.devicePixelRatio || 1;
  return state.ecoMode ? Math.min(raw, 1.25) : Math.min(raw, 2.0);
}

function getTargetSamples() {
  return state.ecoMode ? 4 : 16;
}

function computeTriadCenterCss() {
  const btn = $('triad-btn');
  if (!btn || !state.showHud) return null;
  const r = btn.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  return { x: r.left + r.width * 0.5, y: r.top + r.height * 0.5 };
}

function applyTranslations() {
  t = createTranslator(state.lang);
  document.documentElement.lang = state.lang;
  document.title = t('appTitle');
  const sr = $('sr-heading');
  if (sr) sr.textContent = t('srMainHeading');
  $('btn-lang').textContent = state.lang.toUpperCase();

  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key);
  });
  const urlInput = $('url-load-input');
  if (urlInput) urlInput.placeholder = t('shareOpenUrlPlaceholder');
  const libSearch = $('lib-search');
  if (libSearch) libSearch.placeholder = state.lang === 'tr' ? 'Model ara…' : 'Search models…';
  updateToolbarUi();
  if (state.showShare) renderShareModal();
}

function initWorker() {
  try {
    worker = new Worker('./js/stl_worker.js', { type: 'module' });
    worker.addEventListener('message', (ev) => {
      if (ev.data && ev.data.type === 'ready') workerReady = true;
    });
    worker.addEventListener('error', () => {
      workerReady = false;
      worker = null;
    });
  } catch {
    workerReady = false;
    worker = null;
  }
}

function parseStlAsync(buffer, name) {
  if (!worker || !workerReady) {
    return Promise.resolve(parseStlBuffer(buffer, name));
  }
  const id = ++parseSeq;
  // Pass a copy into the worker so currentRawBuffer stays intact for sharing/vault
  const copy = buffer.slice(0);
  return new Promise((resolve) => {
    const onMsg = (ev) => {
      if (!ev.data || ev.data.id !== id) return;
      worker.removeEventListener('message', onMsg);
      worker.removeEventListener('error', onErr);
      resolve(ev.data.result);
    };
    const onErr = () => {
      worker.removeEventListener('message', onMsg);
      worker.removeEventListener('error', onErr);
      workerReady = false;
      resolve(parseStlBuffer(buffer, name));
    };
    worker.addEventListener('message', onMsg);
    worker.addEventListener('error', onErr);
    worker.postMessage({ id, buffer: copy, name }, [copy]);
  });
}

function showStatus(msg, durationMs = 2200) {
  transientStatus = msg;
  if (statusTimer) clearTimeout(statusTimer);
  updateStatusPill();
  if (durationMs > 0) {
    statusTimer = setTimeout(() => {
      transientStatus = '';
      updateStatusPill();
    }, durationMs);
  }
}

function updateStatusPill() {
  const dot = $('idle-dot');
  const txt = $('status-text');
  const ecoBtn = $('btn-eco');
  const ecoDrawerBtn = $('btn-eco-drawer');
  if (ecoBtn) {
    ecoBtn.setAttribute('aria-pressed', String(state.ecoMode));
    ecoBtn.textContent = state.ecoMode ? t('eco') : t('crisp');
  }
  if (ecoDrawerBtn) {
    ecoDrawerBtn.setAttribute('aria-pressed', String(state.ecoMode));
  }

  if (transientStatus) {
    dot.classList.remove('settled');
    txt.textContent = transientStatus;
    return;
  }

  const samples = renderer ? renderer.accumCount : 0;
  const target = getTargetSamples();
  const settled = renderer && !renderer.needsMoreSamples() && !cam.isAnimating() && !state.turntable;
  dot.classList.toggle('settled', !!settled);
  if (settled) {
    if (renderer.backend === 'WebGL1') txt.textContent = 'WebGL1 · Idle';
    else if (renderer.backend === 'Canvas 2D') txt.textContent = '2D ZBuf · Idle';
    else txt.textContent = `Idle · ${samples}× SSAA`;
  } else if (state.turntable) {
    txt.textContent = `${renderer?.backend || '3D'} · Spin`;
  } else if (renderer && renderer.backend !== 'WebGL2') {
    txt.textContent = `${renderer.backend} · Active`;
  } else {
    txt.textContent = `SSAA ${samples}/${target}`;
  }
}

function updateInfoPill() {
  const nameEl = $('info-name');
  const metricsEl = $('info-metrics');
  if (!currentMesh || !currentMesh.ok) {
    nameEl.textContent = t('noModel');
    metricsEl.textContent = '';
    return;
  }

  const sib =
    state.loadedFiles.length > 1 && state.loadedIndex >= 0
      ? ` [${state.loadedIndex + 1}/${state.loadedFiles.length}]`
      : '';
  nameEl.textContent = `${currentMesh.name}${sib}`;

  const tags = [];
  if (cam.isOrtho()) tags.push('Ortho');
  if (cam.getUpAxis() === 'yup') tags.push('Y-Up');
  const tagStr = tags.length ? ` · ${tags.join(' · ')}` : '';
  const ext = currentMesh.bboxExtent;

  metricsEl.textContent =
    `${formatCount(currentMesh.triCount)} tri · ` +
    `${ext.x.toFixed(1)}×${ext.y.toFixed(1)}×${ext.z.toFixed(1)} mm · ` +
    `${(currentMesh.volumeMm3 * 0.001).toFixed(1)} cm³ · ` +
    `${currentMesh.loadMs.toFixed(0)} ms${tagStr}`;
}

function updateInspectorUi() {
  if (!currentMesh || !currentMesh.ok) return;
  const ext = currentMesh.bboxExtent;
  $('insp-x').textContent = formatDim(ext.x, state.unit);
  $('insp-y').textContent = formatDim(ext.y, state.unit);
  $('insp-z').textContent = formatDim(ext.z, state.unit);
  $('insp-vol').textContent = formatVolume(currentMesh.volumeMm3, state.unit);
  $('insp-area').textContent = formatArea(currentMesh.areaMm2, state.unit);
  $('insp-tris').textContent = currentMesh.triCount.toLocaleString();
  $('insp-fmt').textContent = `${currentMesh.isBinary ? 'Binary' : 'ASCII'} · ${formatBytes(currentMesh.fileBytes)}`;

  const healthEl = $('insp-health');
  healthEl.classList.remove('health-ok', 'health-warn');
  if (currentMesh.invertedWinding) {
    healthEl.textContent = t('healthInverted');
    healthEl.classList.add('health-warn');
  } else if (currentMesh.degenerateTris > 0) {
    healthEl.textContent = `${currentMesh.degenerateTris} ${t('healthDegen')}`;
    healthEl.classList.add('health-warn');
  } else {
    healthEl.textContent = t('healthOk');
    healthEl.classList.add('health-ok');
  }

  const est = estimatePrint(currentMesh.volumeMm3, currentMesh.areaMm2, state.materialId, state.infillPct);
  $('lbl-infill').textContent = `${state.infillPct}%`;
  $('insp-weight').textContent = `${est.weightGrams.toFixed(1)} g`;
  $('insp-filament').textContent = est.filamentMeters > 0 ? `${est.filamentMeters.toFixed(2)} m (1.75mm)` : `${est.effectiveCm3.toFixed(1)} ml`;

  const fit = checkBedFit(ext, state.bedSize);
  const badge = $('insp-plate-status');
  badge.classList.toggle('fits', fit.fits);
  badge.classList.toggle('no-fit', !fit.fits);
  badge.textContent = fit.fits ? (fit.rotated ? t('plateFitsRot') : t('plateFits')) : t('plateTooLarge');
}

function updateSliceUi() {
  const pill = $('slice-pill');
  pill.classList.toggle('hidden', !(state.sliceEnabled && currentMesh && currentMesh.ok));
  if (!state.sliceEnabled || !currentMesh || !currentMesh.ok) return;

  [$('btn-slice-x'), $('btn-slice-y'), $('btn-slice-z')].forEach((b, idx) => {
    b.classList.toggle('active', state.sliceAxis === idx);
  });
  $('btn-slice-flip').setAttribute('aria-pressed', String(state.sliceFlip));
  $('slice-slider').value = String(state.sliceT);

  const ax = state.sliceAxis;
  const minV = ax === 0 ? currentMesh.bboxMin.x : ax === 1 ? currentMesh.bboxMin.y : currentMesh.bboxMin.z;
  const extV = ax === 0 ? currentMesh.bboxExtent.x : ax === 1 ? currentMesh.bboxExtent.y : currentMesh.bboxExtent.z;
  $('slice-mm').textContent = `${(minV + state.sliceT * extV).toFixed(1)} mm`;
}

function updateMeasureUi() {
  const pill = $('measure-pill');
  const txt = $('measure-text');
  const copyBtn = $('btn-measure-copy');
  canvas.classList.toggle('measure-cursor', state.measureMode);
  pill.classList.toggle('hidden', !state.measureMode);
  if (!state.measureMode) return;

  if (!state.measureHasA) {
    txt.textContent = t('measurePickA');
    copyBtn.classList.add('hidden');
  } else if (!state.measureHasB) {
    txt.textContent = t('measurePickB');
    copyBtn.classList.add('hidden');
  } else {
    const d = vSub(state.measureB, state.measureA);
    const dist = vLen(d);
    txt.textContent = `${t('measureDistPrefix')}: ${dist.toFixed(2)} mm (ΔX ${Math.abs(d.x).toFixed(2)} · ΔY ${Math.abs(d.y).toFixed(2)} · ΔZ ${Math.abs(d.z).toFixed(2)})`;
    copyBtn.classList.remove('hidden');
  }
}

function updateToolbarUi() {
  document.body.classList.toggle('theme-light', !state.darkTheme);
  document.body.classList.toggle('theme-dark', state.darkTheme);
  document.body.classList.toggle('drawer-open', state.showInspector);

  $('lbl-matcap').textContent = matcapName(state.matcap);
  $('lbl-theme').textContent = state.darkTheme ? t('themeDark') : t('themeLight');
  $('btn-wire').setAttribute('aria-pressed', String(state.wireframe));
  $('btn-slice').setAttribute('aria-pressed', String(state.sliceEnabled));
  $('btn-measure').setAttribute('aria-pressed', String(state.measureMode));
  $('btn-overhang').setAttribute('aria-pressed', String(state.overhang));
  $('btn-overhang-drawer').setAttribute('aria-pressed', String(state.overhang));
  $('btn-xray').setAttribute('aria-pressed', String(state.xray));
  $('btn-twosided').setAttribute('aria-pressed', String(state.twoSided));
  $('btn-inspect').setAttribute('aria-pressed', String(state.showInspector));
  $('btn-bed-toggle').setAttribute('aria-pressed', String(state.showBed));
  $('btn-turntable').setAttribute('aria-pressed', String(state.turntable));
  $('btn-help').setAttribute('aria-pressed', String(state.showHelp));

  $('btn-ortho').setAttribute('aria-pressed', String(cam.isOrtho()));
  $('btn-yup').setAttribute('aria-pressed', String(cam.getUpAxis() === 'yup'));
  $('btn-grid').setAttribute('aria-pressed', String(state.showGrid));

  $('hud-layer').classList.toggle('hidden', !state.showHud);
  $('btn-restore-hud').classList.toggle('hidden', state.showHud);
  $('inspector-drawer').classList.toggle('hidden', !state.showInspector);
  $('overhang-pill').classList.toggle('hidden', !state.overhang);
  $('help-modal').classList.toggle('hidden', !state.showHelp);
  $('share-modal').classList.toggle('hidden', !state.showShare);
  $('url-modal').classList.toggle('hidden', !state.showUrlModal);

  if (state.showHelp && renderer) {
    const chunkInfo = lastStats ? `${lastStats.visibleChunks}/${lastStats.totalChunks} chunks (${lastStats.drawCalls} draws)` : '—';
    const fboTag = renderer.backend === 'WebGL2' ? (renderer.fp16Fbo ? 'RGBA16F' : 'RGBA8') : renderer.backend;
    $('engine-diag').textContent = `8 B/v UNORM16 · ${chunkInfo} · ${fboTag} · ${renderer.glInfo}`;
  }

  updateInfoPill();
  updateInspectorUi();
  updateSliceUi();
  updateMeasureUi();
  updateStatusPill();
}

function updateModelPopover() {
  // 1. Kasa STL Library
  const libSec = $('kasa-lib-section');
  const libList = $('kasa-lib-list');
  const libSearch = $('lib-search');
  if (state.kasaLibrary.length > 0) {
    libSec.classList.remove('hidden');
    if (libSearch) libSearch.classList.toggle('hidden', state.kasaLibrary.length <= 4);
    const q = (libSearch?.value || '').trim().toLowerCase();
    const filtered = q
      ? state.kasaLibrary.filter((it) => it.name.toLowerCase().includes(q) || it.folder.toLowerCase().includes(q))
      : state.kasaLibrary;
    $('kasa-lib-count').textContent = String(filtered.length);
    libList.innerHTML = '';
    for (const item of filtered) {
      const key = `kasa:${item.root}:${item.relPath}`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `pop-item${state.activeModelKey === key ? ' active' : ''}`;
      btn.innerHTML = `<span class="pop-item-main"><span class="pop-item-name"></span><span class="pop-item-sub mono"></span></span>`;
      btn.querySelector('.pop-item-name').textContent = item.name;
      btn.querySelector('.pop-item-sub').textContent = `${item.folder} · ${formatBytes(item.bytes)}`;
      btn.addEventListener('click', () => {
        closePopovers();
        loadKasaLibraryItem(item);
      });
      libList.appendChild(btn);
    }
  } else {
    libSec.classList.add('hidden');
  }

  // 2. Loaded session files
  const loadedSec = $('loaded-section');
  const loadedList = $('loaded-list');
  if (state.loadedFiles.length > 0) {
    loadedSec.classList.remove('hidden');
    loadedList.innerHTML = '';
    state.loadedFiles.forEach((entry, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `pop-item${state.activeModelKey === `file:${idx}` ? ' active' : ''}`;
      btn.textContent = entry.name;
      btn.addEventListener('click', () => {
        closePopovers();
        loadLocalFileAt(idx);
      });
      loadedList.appendChild(btn);
    });
  } else {
    loadedSec.classList.add('hidden');
  }

  // 3. Persistent IndexedDB Recent Models
  const recSec = $('recent-section');
  const recList = $('recent-list');
  if (state.recentModels.length > 0) {
    recSec.classList.remove('hidden');
    recList.innerHTML = '';
    for (const rec of state.recentModels) {
      const row = document.createElement('div');
      row.className = 'pop-item-row';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `pop-item${state.activeModelKey === `vault:${rec.id}` ? ' active' : ''}`;
      btn.innerHTML = `<span class="pop-item-main"><span class="pop-item-name"></span><span class="pop-item-sub mono"></span></span>`;
      btn.querySelector('.pop-item-name').textContent = rec.name;
      const extStr = rec.extent ? `${rec.extent.x.toFixed(0)}×${rec.extent.y.toFixed(0)}×${rec.extent.z.toFixed(0)}mm` : '';
      btn.querySelector('.pop-item-sub').textContent = `${formatCount(rec.triCount || 0)} tri · ${formatBytes(rec.fileBytes || 0)}${extStr ? ` · ${extStr}` : ''}`;
      btn.addEventListener('click', async () => {
        closePopovers();
        const entry = await getRecentModelBuffer(rec.id);
        if (entry?.buffer) {
          await applyParsedBuffer(entry.buffer, entry.name, `vault:${rec.id}`, { saveToVault: false });
        }
      });

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'pop-del-btn';
      del.title = 'Remove';
      del.setAttribute('aria-label', `Remove ${rec.name}`);
      del.textContent = '×';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        await deleteRecentModel(rec.id);
        state.recentModels = await listRecentModels();
        updateModelPopover();
      });

      row.append(btn, del);
      recList.appendChild(row);
    }
  } else {
    recSec.classList.add('hidden');
  }

  // 4. Built-in CAD Samples
  const demoList = $('demo-list');
  demoList.innerHTML = '';
  for (const dm of DEMO_MODELS) {
    const key = `demo:${dm.id}`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `pop-item${state.activeModelKey === key ? ' active' : ''}`;
    btn.textContent = dm.label;
    btn.addEventListener('click', () => {
      closePopovers();
      loadDemoModel(dm.id);
    });
    demoList.appendChild(btn);
  }
}

function closePopovers() {
  $('model-popover').classList.add('hidden');
  $('btn-model-menu').setAttribute('aria-expanded', 'false');
  $('view-popover').classList.add('hidden');
  $('triad-btn').setAttribute('aria-expanded', 'false');
}

function updateAxisLabels(axisTipsCss) {
  const lx = $('axis-lbl-x');
  const ly = $('axis-lbl-y');
  const lz = $('axis-lbl-z');
  if (!axisTipsCss || !state.showHud) return;
  lx.style.left = `${axisTipsCss[0].x}px`;
  lx.style.top = `${axisTipsCss[0].y}px`;
  ly.style.left = `${axisTipsCss[1].x}px`;
  ly.style.top = `${axisTipsCss[1].y}px`;
  lz.style.left = `${axisTipsCss[2].x}px`;
  lz.style.top = `${axisTipsCss[2].y}px`;
}

function resizeCanvas() {
  if (!renderer) return;
  const dpr = getEffectiveDpr();
  const cssW = Math.max(1, window.innerWidth);
  const cssH = Math.max(1, window.innerHeight);
  const pxW = Math.max(1, Math.round(cssW * dpr));
  const pxH = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== pxW || canvas.height !== pxH) {
    canvas.width = pxW;
    canvas.height = pxH;
  }
  renderer.resize(pxW, pxH, dpr);
  state.triadCenterCss = computeTriadCenterCss();
}

function requestFrame(resetAccum = false) {
  if (!renderer) return;
  if (resetAccum) renderer.resetAccumulation();
  if (document.hidden) return;
  if (!rafId) {
    lastAnimTime = performance.now();
    rafId = requestAnimationFrame(onAnimationFrame);
  }
}

function onAnimationFrame(now) {
  rafId = 0;
  if (document.hidden || !renderer) return;

  const dt = Math.min(0.1, Math.max(0.0, (now - lastAnimTime) * 0.001));
  lastAnimTime = now;

  if (state.turntable) {
    cam.orbit(-dt * 42.0 * getEffectiveDpr(), 0, renderer.width, renderer.height);
    renderer.resetAccumulation();
  } else if (cam.isAnimating()) {
    cam.step(dt);
    renderer.resetAccumulation();
  }

  state.triadCenterCss = computeTriadCenterCss();
  const { cstats, axisTipsCss } = renderer.renderFrame(currentMesh, cam, state);
  lastStats = cstats;
  updateAxisLabels(axisTipsCss);
  updateStatusPill();

  if (state.turntable || cam.isAnimating() || renderer.needsMoreSamples()) {
    rafId = requestAnimationFrame(onAnimationFrame);
  }
}

async function applyParsedBuffer(buffer, name, modelKey, opts = {}) {
  showStatus(t('parsing'), 0);
  const parsed = await parseStlAsync(buffer, name);
  if (!parsed.ok) {
    showStatus(parsed.error || 'Failed to parse STL', 3500);
    return false;
  }

  currentRawBuffer = buffer.slice(0);
  renderer.uploadMesh(parsed);
  if (!renderer.needsCpuVertices) {
    parsed.vertices = null;
  }
  currentMesh = parsed;
  state.activeModelKey = modelKey;
  state.activeSourceUrl = opts.sourceUrl || null;
  state.measureHasA = false;
  state.measureHasB = false;
  state.sliceEnabled = false;

  // Automatically enable 2-sided if mesh has inverted winding so user never sees an inside-out part
  if (parsed.invertedWinding && !state.twoSided) {
    state.twoSided = true;
  }

  cam.frameBounds(parsed.bboxMin, parsed.bboxMax, renderer.width, renderer.height, false);
  if (opts.viewState) {
    applyViewState(opts.viewState);
  } else {
    cam.setPreset(ViewPreset.Iso, false);
  }

  if (opts.saveToVault) {
    const vid = await saveRecentModel({
      name,
      buffer: currentRawBuffer,
      triCount: parsed.triCount,
      extent: parsed.bboxExtent,
    });
    state.recentModels = await listRecentModels();
    if (vid && modelKey.startsWith('file:')) {
      // Keep active file key if part of batch; otherwise vault key
    }
  }

  transientStatus = '';
  updateModelPopover();
  updateToolbarUi();
  requestFrame(true);
  return true;
}

function applyViewState(vs) {
  if (!vs) return;
  cam.applyState(vs);
  if (Number.isInteger(vs.matcap)) state.matcap = vs.matcap;
  if (typeof vs.wireframe === 'boolean') state.wireframe = vs.wireframe;
  if (typeof vs.xray === 'boolean') state.xray = vs.xray;
  if (typeof vs.overhang === 'boolean') state.overhang = vs.overhang;
  if (typeof vs.sliceEnabled === 'boolean') state.sliceEnabled = vs.sliceEnabled;
  if (Number.isInteger(vs.sliceAxis)) state.sliceAxis = vs.sliceAxis;
  if (typeof vs.sliceFlip === 'boolean') state.sliceFlip = vs.sliceFlip;
  if (Number.isFinite(vs.sliceT)) state.sliceT = vs.sliceT;
  if (typeof vs.darkTheme === 'boolean') state.darkTheme = vs.darkTheme;
}

function loadDemoModel(id, viewState = null) {
  const dm = DEMO_MODELS.find((m) => m.id === id) || DEMO_MODELS[0];
  const buf = generateDemoStl(dm.id);
  return applyParsedBuffer(buf, dm.name, `demo:${dm.id}`, { saveToVault: false, viewState });
}

async function loadLocalFileAt(idx) {
  const entry = state.loadedFiles[idx];
  if (!entry) return;
  state.loadedIndex = idx;
  const buf = entry.buffer ? entry.buffer.slice(0) : await entry.file.arrayBuffer();
  await applyParsedBuffer(buf, entry.name, `file:${idx}`, { saveToVault: true });
}

async function handleSelectedFiles(fileList) {
  const rawFiles = Array.from(fileList || []);
  const expanded = [];

  for (const f of rawFiles) {
    if (/\.zip$/i.test(f.name)) {
      showStatus(t('extractingZip'), 0);
      try {
        const zbuf = await f.arrayBuffer();
        const stls = await extractStlsFromZip(zbuf);
        for (const s of stls) expanded.push({ name: s.name, buffer: s.buffer });
      } catch (err) {
        showStatus(`ZIP error: ${err?.message || 'failed'}`, 3000);
      }
    } else if (/\.stl$/i.test(f.name) || rawFiles.length === 1) {
      expanded.push({ name: f.name || 'model.stl', file: f });
    }
  }

  if (expanded.length === 0) {
    showStatus('No .stl file found', 2500);
    return;
  }
  state.loadedFiles = expanded;
  await loadLocalFileAt(0);
}

async function loadFromUrl(rawUrl, viewState = null) {
  const normalized = normalizeStlUrl(rawUrl);
  if (!normalized) return;
  try {
    showStatus(t('fetchingUrl'), 0);
    let resp;
    try {
      resp = await fetch(normalized);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    } catch (directErr) {
      if (state.serverMode && /^https?:\/\//i.test(normalized)) {
        resp = await fetch(`./api/proxy?url=${encodeURIComponent(normalized)}`);
        if (!resp.ok) throw new Error(`Proxy HTTP ${resp.status}`);
      } else {
        throw directErr;
      }
    }
    const buf = await resp.arrayBuffer();
    const cleanName = normalized.split('/').pop()?.split('?')[0] || 'remote.stl';
    if (/\.zip$/i.test(cleanName)) {
      const stls = await extractStlsFromZip(buf);
      if (stls.length === 0) throw new Error('ZIP contains no .stl');
      state.loadedFiles = stls;
      await loadLocalFileAt(0);
      return;
    }
    await applyParsedBuffer(buf, cleanName, `url:${normalized}`, {
      sourceUrl: normalized,
      saveToVault: true,
      viewState,
    });
  } catch (err) {
    showStatus(`URL load failed: ${err.message}`, 3500);
    if (!currentMesh) loadDemoModel('flange-housing');
  }
}

async function loadKasaLibraryItem(item) {
  try {
    showStatus(t('fetchingUrl'), 0);
    const resp = await fetch(
      `./api/library/file?root=${encodeURIComponent(item.root)}&path=${encodeURIComponent(item.relPath)}`
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = await resp.arrayBuffer();
    await applyParsedBuffer(buf, item.name, `kasa:${item.root}:${item.relPath}`, { saveToVault: false });
  } catch (err) {
    showStatus(`Library load failed: ${err.message}`, 3000);
  }
}

async function loadSharedId(id, fallbackName, viewState = null) {
  try {
    showStatus(t('fetchingUrl'), 0);
    const resp = await fetch(`/api/share/${encodeURIComponent(id)}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const hdrName = resp.headers.get('X-Model-Name');
    const name = hdrName ? decodeURIComponent(hdrName) : fallbackName || `${id}.stl`;
    const buf = await resp.arrayBuffer();
    await applyParsedBuffer(buf, name, `share:${id}`, { saveToVault: true, viewState });
  } catch (err) {
    showStatus(`Share load failed: ${err.message}`, 3500);
    loadDemoModel('flange-housing');
  }
}

function resetView(animate = true) {
  if (!currentMesh || !currentMesh.ok) return;
  state.turntable = false;
  cam.frameBounds(currentMesh.bboxMin, currentMesh.bboxMax, renderer.width, renderer.height, animate);
  cam.setPreset(ViewPreset.Iso, animate);
  updateToolbarUi();
  requestFrame(true);
}

function handleDoublePick(cssX, cssY) {
  if (!currentMesh || !currentMesh.ok) return;
  const pt = renderer.pickWorldPoint(cssX, cssY, cam, currentMesh, state);
  if (pt) {
    cam.setPivot(pt, true);
    showStatus(t('pivotSet'), 1400);
    requestFrame(true);
  } else {
    resetView(true);
    showStatus(t('viewReset'), 1200);
  }
}

function handleMeasurePick(cssX, cssY) {
  if (!currentMesh || !currentMesh.ok) return;
  const pt = renderer.pickWorldPoint(cssX, cssY, cam, currentMesh, state);
  if (!pt) {
    showStatus(t('clickSurfaceToMeasure'), 1600);
    return;
  }
  if (!state.measureHasA || state.measureHasB) {
    state.measureA = pt;
    state.measureHasA = true;
    state.measureHasB = false;
  } else {
    state.measureB = pt;
    state.measureHasB = true;
  }
  updateMeasureUi();
  requestFrame(true);
}

function downloadCurrentStl() {
  if (!currentRawBuffer || !currentMesh) return;
  const blob = new Blob([currentRawBuffer], { type: 'model/stl' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = currentMesh.name || 'model.stl';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  showStatus(t('stlDownloaded'), 1800);
}

function exportPngSnapshot() {
  if (!renderer || !currentMesh) return;
  // Render synchronously right before reading pixels so preserveDrawingBuffer:false never exports black!
  const prevHud = state.showHud;
  state.showHud = false;
  renderer.resetAccumulation();
  renderer.renderFrame(currentMesh, cam, state);
  const dataUrl = canvas.toDataURL('image/png');
  state.showHud = prevHud;
  requestFrame(true);

  const a = document.createElement('a');
  const stem = (currentMesh.name || 'model').replace(/\.stl$/i, '');
  a.download = `${stem}-view.png`;
  a.href = dataUrl;
  a.click();
  showStatus(t('snapshotSaved'), 1800);
}

async function copyText(str) {
  try {
    await navigator.clipboard.writeText(str);
    showStatus(t('copied'), 1400);
    return true;
  } catch {
    showStatus(str.slice(0, 48), 2000);
    return false;
  }
}

// --- Access & Share Modal Logic ---
function getAccessOptions() {
  const opts = [];
  const info = state.accessInfo;
  if (info?.publicTunnel) {
    opts.push({ key: 'public', label: t('shareAddrPublic'), url: info.publicTunnel });
  }
  opts.push({
    key: 'pages',
    label: t('shareAddrPages'),
    url: info?.githubPages || GITHUB_PAGES_FALLBACK,
  });
  if (info?.lanShort) {
    opts.push({ key: 'lan', label: t('shareAddrLan'), url: info.lanShort });
  }
  if (info?.tailscale) {
    opts.push({ key: 'tailscale', label: t('shareAddrTailscale'), url: info.tailscale });
  }
  const currentClean = `${window.location.origin}${window.location.pathname}`;
  if (!opts.some((o) => o.url.replace(/\/$/, '') === currentClean.replace(/\/$/, ''))) {
    opts.push({ key: 'current', label: t('shareAddrCurrent'), url: currentClean });
  }
  return opts;
}

function renderShareModal() {
  const badge = $('server-mode-badge');
  badge.textContent = state.serverMode ? t('kasaConnected') : t('staticModeBadge');
  badge.classList.toggle('connected', state.serverMode);

  $('tab-share-access').classList.toggle('active', state.shareTab === 'access');
  $('tab-share-access').setAttribute('aria-selected', String(state.shareTab === 'access'));
  $('tab-share-model').classList.toggle('active', state.shareTab === 'model');
  $('tab-share-model').setAttribute('aria-selected', String(state.shareTab === 'model'));
  $('panel-share-access').classList.toggle('hidden', state.shareTab !== 'access');
  $('panel-share-model').classList.toggle('hidden', state.shareTab !== 'model');

  const opts = getAccessOptions();
  if (!opts.some((o) => o.key === state.selectedAccessKey)) {
    state.selectedAccessKey = opts[0]?.key || 'pages';
  }
  const chips = $('access-url-chips');
  chips.innerHTML = '';
  for (const o of opts) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `chip-btn${state.selectedAccessKey === o.key ? ' active' : ''}`;
    b.textContent = o.label;
    b.addEventListener('click', () => {
      state.selectedAccessKey = o.key;
      renderShareModal();
    });
    chips.appendChild(b);
  }

  const chosen = opts.find((o) => o.key === state.selectedAccessKey) || opts[0];
  if (chosen) {
    $('access-url-input').value = chosen.url;
    const openLink = $('link-open-access');
    if (openLink) {
      openLink.href = chosen.url;
      openLink.textContent = state.lang === 'tr' ? 'Aç ↗' : 'Open ↗';
    }
    $('access-qr-box').innerHTML = renderQrSvg(chosen.url, { size: 152, label: chosen.label });
  }

  $('share-model-desc').textContent = state.serverMode ? t('shareModelDescServer') : t('shareModelDescStatic');
}

async function generateModelShareLink() {
  if (!currentMesh || !currentRawBuffer) return;
  const viewToken = encodeViewHash({
    ...cam.getState(),
    matcap: state.matcap,
    wireframe: state.wireframe,
    xray: state.xray,
    overhang: state.overhang,
    sliceEnabled: state.sliceEnabled,
    sliceAxis: state.sliceAxis,
    sliceFlip: state.sliceFlip,
    sliceT: state.sliceT,
    darkTheme: state.darkTheme,
  });

  const resBox = $('model-share-result');
  const noteEl = $('model-share-note');

  // Path 1: Kasa backend upload -> short public or LAN link + QR
  if (state.serverMode) {
    try {
      showStatus(t('uploadingShare'), 0);
      const resp = await fetch('/api/share', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Filename': encodeURIComponent(currentMesh.name || 'model.stl'),
        },
        body: currentRawBuffer,
      });
      const data = await resp.json();
      if (!resp.ok || !data.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      const baseOrigin = state.accessInfo?.publicTunnel || window.location.origin;
      const fullUrl = `${baseOrigin.replace(/\/$/, '')}${data.sharePath}#v=${viewToken}`;
      $('model-share-input').value = fullUrl;
      const openShare = $('link-open-model-share');
      if (openShare) {
        openShare.href = fullUrl;
        openShare.textContent = state.lang === 'tr' ? 'Aç ↗' : 'Open ↗';
      }
      $('model-qr-box').innerHTML = renderQrSvg(fullUrl, { size: 152, label: currentMesh.name });
      noteEl.textContent = `${currentMesh.name} · ${formatBytes(data.bytes)}`;
      resBox.classList.remove('hidden');
      showStatus(t('ready'), 1200);
      return;
    } catch (err) {
      showStatus(`Share failed: ${err.message}`, 3000);
    }
  }

  // Path 2: Static / Serverless mode (external URL or compact gzipped inline model)
  const setStaticShare = (fullUrl, qrTarget, noteText) => {
    $('model-share-input').value = fullUrl;
    const openShare = $('link-open-model-share');
    if (openShare) {
      openShare.href = fullUrl;
      openShare.textContent = state.lang === 'tr' ? 'Aç ↗' : 'Open ↗';
    }
    $('model-qr-box').innerHTML = qrTarget && qrTarget.length <= 540
      ? renderQrSvg(qrTarget, { size: 152, label: currentMesh.name })
      : '';
    noteEl.textContent = noteText;
    resBox.classList.remove('hidden');
  };

  const base = `${window.location.origin}${window.location.pathname}`;
  if (state.activeSourceUrl) {
    const fullUrl = `${base}?url=${encodeURIComponent(state.activeSourceUrl)}#v=${viewToken}`;
    setStaticShare(fullUrl, fullUrl, currentMesh.name);
    return;
  }

  if (state.activeModelKey.startsWith('demo:')) {
    const dmId = state.activeModelKey.slice(5);
    const fullUrl = `${base}?demo=${encodeURIComponent(dmId)}#v=${viewToken}`;
    setStaticShare(fullUrl, fullUrl, currentMesh.name);
    return;
  }

  const packed = await encodeInlineModel(currentRawBuffer, currentMesh.name);
  if (packed.ok) {
    const fullUrl = `${base}#m=${packed.token}&v=${viewToken}`;
    setStaticShare(fullUrl, fullUrl, `Serverless gzip (${formatBytes(packed.compressedBytes)})`);
  } else {
    setStaticShare(
      `${base}#v=${viewToken}`,
      base,
      `Model > 120 KB gzipped — open via Kasa server (http://stl) for 50 MB instant QR sharing.`
    );
  }
}

async function probeKasaBackend() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1600);
    const resp = await fetch('./api/access-info', { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(timer);
    if (!resp.ok) return;
    const ct = resp.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return;
    const info = await resp.json();
    if (info && info.serverMode) {
      state.serverMode = true;
      state.accessInfo = info;
      state.selectedAccessKey = info.publicTunnel ? 'public' : 'lan';
      if (state.showShare) renderShareModal();
      // Load Kasa STL library asynchronously
      const libResp = await fetch('./api/library', { cache: 'no-store' });
      if (libResp.ok) {
        const libData = await libResp.json();
        if (Array.isArray(libData.items)) {
          state.kasaLibrary = libData.items;
          updateModelPopover();
        }
      }
    }
  } catch {
    // Expected on GitHub Pages / offline PWA — stay silently in zero-error static mode!
    state.serverMode = false;
  }
}

function populateInspectorSelects() {
  const matSel = $('sel-material');
  matSel.innerHTML = '';
  for (const m of MATERIALS) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = `${m.name} (${m.densityGcm3} g/cm³)`;
    matSel.appendChild(opt);
  }
  matSel.value = state.materialId;

  const plateSel = $('sel-plate');
  plateSel.innerHTML = '';
  for (const p of BUILD_PLATES) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.label;
    plateSel.appendChild(opt);
  }
  plateSel.value = state.bedId;
}

function wireControls() {
  // Pointer & Multi-touch gestures
  const pointers = new Map();
  let dragMode = null;
  let moved = false;
  let downX = 0, downY = 0;
  let lastX = 0, lastY = 0;
  let lastPinchDist = 0;
  let lastTapTime = 0, lastTapX = 0, lastTapY = 0;

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('pointerdown', (e) => {
    closePopovers();
    if (state.turntable) {
      state.turntable = false;
      updateToolbarUi();
    }
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 1) {
      moved = false;
      downX = lastX = e.clientX;
      downY = lastY = e.clientY;
      dragMode = e.button === 1 || e.button === 2 || e.shiftKey ? 'pan' : 'orbit';
    } else if (pointers.size === 2) {
      dragMode = 'pinch';
      moved = true;
      const pts = Array.from(pointers.values());
      lastPinchDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      lastX = (pts[0].x + pts[1].x) * 0.5;
      lastY = (pts[0].y + pts[1].y) * 0.5;
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 2 && dragMode === 'pinch') {
      const pts = Array.from(pointers.values());
      const cx = (pts[0].x + pts[1].x) * 0.5;
      const cy = (pts[0].y + pts[1].y) * 0.5;
      const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      const dpr = getEffectiveDpr();
      cam.pan((cx - lastX) * dpr, (cy - lastY) * dpr, renderer.width, renderer.height);
      if (lastPinchDist > 1) {
        const steps = Math.log(dist / lastPinchDist) / Math.log(1 / 0.86);
        cam.zoom(steps, cx * dpr, cy * dpr, renderer.width, renderer.height);
      }
      lastX = cx;
      lastY = cy;
      lastPinchDist = dist;
      requestFrame(true);
      return;
    }

    if (pointers.size === 1 && dragMode) {
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 4) moved = true;
      lastX = e.clientX;
      lastY = e.clientY;
      const dpr = getEffectiveDpr();
      if (dragMode === 'pan') cam.pan(dx * dpr, dy * dpr, renderer.width, renderer.height);
      else cam.orbit(dx * dpr, dy * dpr, renderer.width, renderer.height);
      requestFrame(true);
    }
  });

  const endPointer = (e) => {
    const wasSingleTap = pointers.size === 1 && !moved && e.button === 0;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) {
      dragMode = pointers.size === 1 ? 'orbit' : null;
      if (pointers.size === 1) {
        const rem = Array.from(pointers.values())[0];
        lastX = rem.x;
        lastY = rem.y;
      }
    }

    if (wasSingleTap) {
      if (state.measureMode) {
        handleMeasurePick(e.clientX, e.clientY);
        return;
      }
      if (e.pointerType === 'touch') {
        const now = performance.now();
        if (now - lastTapTime < 320 && Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY) < 28) {
          lastTapTime = 0;
          handleDoublePick(e.clientX, e.clientY);
        } else {
          lastTapTime = now;
          lastTapX = e.clientX;
          lastTapY = e.clientY;
        }
      }
    }
  };

  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('dblclick', (e) => {
    if (!state.measureMode) handleDoublePick(e.clientX, e.clientY);
  });

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      let delta = -e.deltaY;
      if (e.deltaMode === 1) delta *= 32;
      else if (e.deltaMode === 2) delta *= 240;
      const steps = Math.max(-3, Math.min(3, delta / 120));
      const dpr = getEffectiveDpr();
      cam.zoom(steps, e.clientX * dpr, e.clientY * dpr, renderer.width, renderer.height);
      requestFrame(true);
    },
    { passive: false }
  );

  // Popovers
  $('btn-model-menu').addEventListener('click', (e) => {
    e.stopPropagation();
    const pop = $('model-popover');
    const open = pop.classList.contains('hidden');
    closePopovers();
    if (open) {
      updateModelPopover();
      pop.classList.remove('hidden');
      $('btn-model-menu').setAttribute('aria-expanded', 'true');
    }
  });

  $('triad-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const pop = $('view-popover');
    const open = pop.classList.contains('hidden');
    closePopovers();
    if (open) {
      pop.classList.remove('hidden');
      $('triad-btn').setAttribute('aria-expanded', 'true');
    }
  });

  document.addEventListener('click', (e) => {
    if (
      !e.target.closest('#model-popover') && !e.target.closest('#btn-model-menu') &&
      !e.target.closest('#view-popover') && !e.target.closest('#triad-btn')
    ) {
      closePopovers();
    }
  });

  // Model Hub actions
  $('btn-pop-open').addEventListener('click', () => { closePopovers(); $('file-input').click(); });
  $('btn-pop-url').addEventListener('click', () => {
    closePopovers();
    state.showUrlModal = true;
    updateToolbarUi();
    setTimeout(() => $('url-load-input').focus(), 20);
  });
  $('btn-clear-recents').addEventListener('click', async () => {
    await clearRecentModels();
    state.recentModels = [];
    updateModelPopover();
  });

  $('lib-search')?.addEventListener('input', () => updateModelPopover());

  $('btn-open').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', (e) => {
    if (e.target.files?.length) handleSelectedFiles(e.target.files);
    e.target.value = '';
  });

  // Top-right actions
  $('btn-share').addEventListener('click', () => {
    closePopovers();
    state.showShare = true;
    $('model-share-result').classList.add('hidden');
    updateToolbarUi();
    renderShareModal();
  });
  $('btn-share-close').addEventListener('click', () => { state.showShare = false; updateToolbarUi(); });
  $('share-modal').addEventListener('click', (e) => {
    if (e.target === $('share-modal')) { state.showShare = false; updateToolbarUi(); }
  });
  $('tab-share-access').addEventListener('click', () => { state.shareTab = 'access'; renderShareModal(); });
  $('tab-share-model').addEventListener('click', () => { state.shareTab = 'model'; renderShareModal(); });
  $('btn-copy-access').addEventListener('click', () => copyText($('access-url-input').value));
  $('btn-generate-share').addEventListener('click', () => generateModelShareLink());
  $('btn-copy-model-share').addEventListener('click', () => copyText($('model-share-input').value));

  $('btn-url-close').addEventListener('click', () => { state.showUrlModal = false; updateToolbarUi(); });
  $('url-modal').addEventListener('click', (e) => {
    if (e.target === $('url-modal')) { state.showUrlModal = false; updateToolbarUi(); }
  });
  $('url-load-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const val = $('url-load-input').value.trim();
    state.showUrlModal = false;
    updateToolbarUi();
    if (val) loadFromUrl(val);
  });

  $('btn-inspect').addEventListener('click', () => {
    closePopovers();
    state.showInspector = !state.showInspector;
    updateToolbarUi();
    // Re-sync triad position after drawer layout shift
    requestAnimationFrame(() => requestFrame(false));
  });
  $('btn-inspector-close').addEventListener('click', () => {
    state.showInspector = false;
    updateToolbarUi();
    requestAnimationFrame(() => requestFrame(false));
  });

  // Inspector controls
  document.querySelectorAll('.unit-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.unit = btn.dataset.unit || 'mm';
      document.querySelectorAll('.unit-btn').forEach((b) => b.classList.toggle('active', b === btn));
      updateInspectorUi();
    });
  });
  $('sel-material').addEventListener('change', (e) => {
    state.materialId = e.target.value;
    updateInspectorUi();
  });
  $('infill-slider').addEventListener('input', (e) => {
    state.infillPct = Number(e.target.value);
    updateInspectorUi();
  });
  $('sel-plate').addEventListener('change', (e) => {
    state.bedId = e.target.value;
    state.bedSize = BUILD_PLATES.find((p) => p.id === state.bedId) || BUILD_PLATES[0];
    updateInspectorUi();
    if (state.showBed) requestFrame(true);
  });
  $('btn-bed-toggle').addEventListener('click', () => {
    state.showBed = !state.showBed;
    updateToolbarUi();
    requestFrame(true);
  });
  $('btn-turntable').addEventListener('click', () => {
    state.turntable = !state.turntable;
    updateToolbarUi();
    requestFrame(true);
  });
  $('btn-snapshot').addEventListener('click', () => exportPngSnapshot());
  $('btn-download-stl')?.addEventListener('click', () => downloadCurrentStl());
  $('btn-download-stl-share')?.addEventListener('click', () => downloadCurrentStl());

  // Toolbar controls
  $('btn-matcap').addEventListener('click', () => {
    state.matcap = (state.matcap + 1) % MatcapKind.Count;
    updateToolbarUi();
    requestFrame(true);
  });
  $('btn-wire').addEventListener('click', () => {
    state.wireframe = !state.wireframe;
    updateToolbarUi();
    requestFrame(true);
  });
  $('btn-slice').addEventListener('click', () => {
    state.sliceEnabled = !state.sliceEnabled;
    updateToolbarUi();
    requestFrame(true);
  });
  $('btn-measure').addEventListener('click', () => {
    state.measureMode = !state.measureMode;
    if (!state.measureMode) { state.measureHasA = false; state.measureHasB = false; }
    updateToolbarUi();
    requestFrame(true);
  });
  $('btn-measure-clear').addEventListener('click', () => {
    state.measureHasA = false;
    state.measureHasB = false;
    updateMeasureUi();
    requestFrame(true);
  });
  $('btn-measure-copy').addEventListener('click', () => copyText($('measure-text').textContent || ''));

  const toggleOverhang = () => {
    state.overhang = !state.overhang;
    updateToolbarUi();
    requestFrame(true);
  };
  $('btn-overhang').addEventListener('click', toggleOverhang);
  $('btn-overhang-drawer').addEventListener('click', toggleOverhang);

  [$('btn-slice-x'), $('btn-slice-y'), $('btn-slice-z')].forEach((btn) => {
    btn.addEventListener('click', () => {
      state.sliceAxis = Number(btn.dataset.axis);
      updateSliceUi();
      requestFrame(true);
    });
  });
  $('btn-slice-flip').addEventListener('click', () => {
    state.sliceFlip = !state.sliceFlip;
    updateSliceUi();
    requestFrame(true);
  });
  $('slice-slider').addEventListener('input', (e) => {
    state.sliceT = parseFloat(e.target.value);
    updateSliceUi();
    requestFrame(true);
  });

  $('btn-xray').addEventListener('click', () => {
    state.xray = !state.xray;
    updateToolbarUi();
    requestFrame(true);
  });
  $('btn-twosided').addEventListener('click', () => {
    state.twoSided = !state.twoSided;
    updateToolbarUi();
    requestFrame(true);
  });
  $('btn-theme').addEventListener('click', () => {
    state.darkTheme = !state.darkTheme;
    updateToolbarUi();
    requestFrame(true);
  });

  const toggleEco = () => {
    state.ecoMode = !state.ecoMode;
    renderer.setTargetSamples(getTargetSamples());
    resizeCanvas();
    updateToolbarUi();
    showStatus(state.ecoMode ? 'Eco (low power)' : 'Crisp 16× SSAA', 1600);
    requestFrame(true);
  };
  $('btn-eco').addEventListener('click', toggleEco);
  $('btn-eco-drawer')?.addEventListener('click', toggleEco);

  $('btn-lang').addEventListener('click', () => {
    state.lang = state.lang === 'tr' ? 'en' : 'tr';
    try { localStorage.setItem('stlviewer_lang', state.lang); } catch {}
    applyTranslations();
  });

  $('btn-install').addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    $('btn-install').classList.add('hidden');
  });

  $('btn-reset').addEventListener('click', () => resetView(true));
  $('btn-help').addEventListener('click', () => {
    state.showHelp = !state.showHelp;
    updateToolbarUi();
  });
  $('btn-help-close').addEventListener('click', () => {
    state.showHelp = false;
    updateToolbarUi();
  });
  $('help-modal').addEventListener('click', (e) => {
    if (e.target === $('help-modal')) { state.showHelp = false; updateToolbarUi(); }
  });

  document.querySelectorAll('#view-popover [data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.turntable = false;
      cam.setPreset(btn.dataset.view, true);
      closePopovers();
      updateToolbarUi();
      requestFrame(true);
    });
  });
  $('btn-ortho').addEventListener('click', () => { cam.toggleOrtho(); updateToolbarUi(); requestFrame(true); });
  $('btn-yup').addEventListener('click', () => { cam.toggleUpAxis(); updateToolbarUi(); requestFrame(true); });
  $('btn-grid').addEventListener('click', () => { state.showGrid = !state.showGrid; updateToolbarUi(); requestFrame(true); });
  $('btn-hide-hud').addEventListener('click', () => {
    closePopovers();
    state.showHud = false;
    updateToolbarUi();
    requestFrame(false);
  });
  $('btn-restore-hud').addEventListener('click', () => {
    state.showHud = true;
    updateToolbarUi();
    requestAnimationFrame(() => requestFrame(false));
  });

  // Drag & drop STL / ZIP files
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (e.dataTransfer?.types?.includes('Files')) {
      dragDepth++;
      $('drop-overlay').classList.remove('hidden');
    }
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) $('drop-overlay').classList.add('hidden');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('drop-overlay').classList.add('hidden');
    if (e.dataTransfer?.files?.length) handleSelectedFiles(e.dataTransfer.files);
  });

  // Global Paste (Ctrl+V): STL file, URL, or raw ASCII STL text
  window.addEventListener('paste', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    const files = e.clipboardData?.files;
    if (files && files.length > 0) {
      e.preventDefault();
      handleSelectedFiles(files);
      return;
    }
    const text = (e.clipboardData?.getData('text') || '').trim();
    if (!text) return;
    if (/^https?:\/\/\S+$/i.test(text)) {
      e.preventDefault();
      loadFromUrl(text);
    } else if (/^solid\b/i.test(text) && /\bfacet\b/i.test(text)) {
      e.preventDefault();
      const buf = new TextEncoder().encode(text).buffer;
      applyParsedBuffer(buf, 'pasted.stl', 'paste:ascii', { saveToVault: true });
    }
  });

  // Keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closePopovers();
      if (state.showShare) { state.showShare = false; updateToolbarUi(); return; }
      if (state.showUrlModal) { state.showUrlModal = false; updateToolbarUi(); return; }
      if (state.showHelp) { state.showHelp = false; updateToolbarUi(); return; }
      if (state.showInspector) { state.showInspector = false; updateToolbarUi(); requestAnimationFrame(() => requestFrame(false)); return; }
      if (state.measureMode) {
        if (state.measureHasA || state.measureHasB) { state.measureHasA = false; state.measureHasB = false; }
        else state.measureMode = false;
        updateToolbarUi();
        requestFrame(true);
        return;
      }
      if (state.sliceEnabled) { state.sliceEnabled = false; updateToolbarUi(); requestFrame(true); return; }
      return;
    }

    const isTextInput =
      e.target &&
      (e.target.tagName === 'TEXTAREA' ||
        e.target.tagName === 'SELECT' ||
        (e.target.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button'].includes(e.target.type)));

    if (isTextInput) {
      if (e.key === 'Tab' && state.sliceEnabled) {
        e.preventDefault();
        state.sliceAxis = (state.sliceAxis + 1) % 3;
        updateSliceUi();
        requestFrame(true);
      }
      return;
    }

    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const k = e.key;
    if (k === 'F1' || k === '?') {
      e.preventDefault();
      state.showHelp = !state.showHelp;
      updateToolbarUi();
      return;
    }
    if (k === 'Tab' && state.sliceEnabled) {
      e.preventDefault();
      state.sliceAxis = (state.sliceAxis + 1) % 3;
      updateSliceUi();
      requestFrame(true);
      return;
    }

    switch (k.toLowerCase()) {
      case '1': cam.setPreset(ViewPreset.Front, true); requestFrame(true); break;
      case '2': cam.setPreset(ViewPreset.Back, true); requestFrame(true); break;
      case '3': cam.setPreset(ViewPreset.Right, true); requestFrame(true); break;
      case '4': cam.setPreset(ViewPreset.Left, true); requestFrame(true); break;
      case '5': cam.setPreset(ViewPreset.Top, true); requestFrame(true); break;
      case '6': cam.setPreset(ViewPreset.Bottom, true); requestFrame(true); break;
      case '0': cam.setPreset(ViewPreset.Iso, true); requestFrame(true); break;
      case 'p': cam.toggleOrtho(); updateToolbarUi(); requestFrame(true); break;
      case 'u': cam.toggleUpAxis(); updateToolbarUi(); requestFrame(true); break;
      case 'g': state.showGrid = !state.showGrid; updateToolbarUi(); requestFrame(true); break;
      case 'm': state.matcap = (state.matcap + 1) % MatcapKind.Count; updateToolbarUi(); requestFrame(true); break;
      case 'w': state.wireframe = !state.wireframe; updateToolbarUi(); requestFrame(true); break;
      case 's': state.sliceEnabled = !state.sliceEnabled; updateToolbarUi(); requestFrame(true); break;
      case 'i': if (state.sliceEnabled) { state.sliceFlip = !state.sliceFlip; updateSliceUi(); requestFrame(true); } break;
      case 'a': toggleOverhang(); break;
      case 'v': state.turntable = !state.turntable; updateToolbarUi(); requestFrame(true); break;
      case 'c': exportPngSnapshot(); break;
      case 'n': $('btn-inspect').click(); break;
      case 'k': $('btn-share').click(); break;
      case 'l':
        state.showUrlModal = true;
        updateToolbarUi();
        setTimeout(() => $('url-load-input').focus(), 20);
        break;
      case 'd':
        state.measureMode = !state.measureMode;
        if (!state.measureMode) { state.measureHasA = false; state.measureHasB = false; }
        updateToolbarUi();
        requestFrame(true);
        break;
      case 'x': state.xray = !state.xray; updateToolbarUi(); requestFrame(true); break;
      case 'b': state.twoSided = !state.twoSided; updateToolbarUi(); requestFrame(true); break;
      case 'e': toggleEco(); break;
      case 't': state.darkTheme = !state.darkTheme; updateToolbarUi(); requestFrame(true); break;
      case 'o': $('file-input').click(); break;
      case 'r':
      case 'f': resetView(true); break;
      case '+':
      case '=':
        cam.zoom(1.5, renderer.width * 0.5, renderer.height * 0.5, renderer.width, renderer.height);
        requestFrame(true);
        break;
      case '-':
      case '_':
        cam.zoom(-1.5, renderer.width * 0.5, renderer.height * 0.5, renderer.width, renderer.height);
        requestFrame(true);
        break;
      case 'h':
        state.showHud = !state.showHud;
        updateToolbarUi();
        requestAnimationFrame(() => requestFrame(false));
        break;
      case '[':
        if (state.loadedFiles.length > 1) {
          const prev = (state.loadedIndex - 1 + state.loadedFiles.length) % state.loadedFiles.length;
          loadLocalFileAt(prev);
        } else if (state.activeModelKey.startsWith('demo:')) {
          const curIdx = DEMO_MODELS.findIndex((m) => `demo:${m.id}` === state.activeModelKey);
          const prevDm = DEMO_MODELS[(curIdx - 1 + DEMO_MODELS.length) % DEMO_MODELS.length];
          loadDemoModel(prevDm.id);
        }
        break;
      case ']':
        if (state.loadedFiles.length > 1) {
          const next = (state.loadedIndex + 1) % state.loadedFiles.length;
          loadLocalFileAt(next);
        } else if (state.activeModelKey.startsWith('demo:')) {
          const curIdx = DEMO_MODELS.findIndex((m) => `demo:${m.id}` === state.activeModelKey);
          const nextDm = DEMO_MODELS[(curIdx + 1) % DEMO_MODELS.length];
          loadDemoModel(nextDm.id);
        }
        break;
    }
  });

  window.addEventListener('resize', () => {
    resizeCanvas();
    requestFrame(true);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    } else if (!document.hidden && renderer && (state.turntable || cam.isAnimating() || renderer.needsMoreSamples())) {
      requestFrame(false);
    }
  });

  // PWA install prompt
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    $('btn-install').classList.remove('hidden');
  });
}

function initBestRenderer(forceTier = null) {
  let tiers = [Renderer, RendererWebGL1, RendererCanvas2D];
  if (forceTier === '2d') tiers = [RendererCanvas2D];
  else if (forceTier === 'webgl1') tiers = [RendererWebGL1, RendererCanvas2D];

  const dpr = getEffectiveDpr();
  const w = Math.max(1, Math.round(window.innerWidth * dpr));
  const h = Math.max(1, Math.round(window.innerHeight * dpr));
  let lastErr = null;

  for (let i = 0; i < tiers.length; i++) {
    if (i > 0) {
      const fresh = canvas.cloneNode(false);
      canvas.replaceWith(fresh);
      canvas = fresh;
    }
    canvas.width = w;
    canvas.height = h;
    try {
      const candidate = new tiers[i](canvas);
      candidate.init(w, h, dpr);
      candidate.setTargetSamples(getTargetSamples());
      return candidate;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('No graphics renderer could be initialized.');
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator && (window.location.protocol === 'https:' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

async function consumeShareTargetIfPresent() {
  if (!('caches' in window)) return false;
  try {
    const cache = await caches.open('stlviewer-share-inbox');
    const resp = await cache.match('/__shared_stl__');
    if (!resp) return false;
    const rawName = resp.headers.get('X-File-Name');
    const name = rawName ? decodeURIComponent(rawName) : 'shared.stl';
    const buf = await resp.arrayBuffer();
    await cache.delete('/__shared_stl__');
    if (/\.zip$/i.test(name)) {
      const stls = await extractStlsFromZip(buf);
      if (stls.length > 0) {
        state.loadedFiles = stls;
        await loadLocalFileAt(0);
        return true;
      }
    }
    await applyParsedBuffer(buf, name, 'share-target:file', { saveToVault: true });
    return true;
  } catch {
    return false;
  }
}

function wireFileHandlingQueue() {
  if (!('launchQueue' in window)) return;
  window.launchQueue.setConsumer(async (launchParams) => {
    if (!launchParams?.files?.length) return;
    const files = [];
    for (const handle of launchParams.files) {
      try { files.push(await handle.getFile()); } catch {}
    }
    if (files.length > 0) handleSelectedFiles(files);
  });
}

async function boot() {
  const params = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
  const viewState = decodeViewHash(hashParams.get('v'));

  initWorker();
  populateInspectorSelects();

  try {
    renderer = initBestRenderer(params.get('renderer'));
  } catch (err) {
    $('error-msg').textContent = err?.message || 'Graphics renderer initialization failed.';
    $('error-banner').classList.remove('hidden');
    return;
  }

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    showStatus('Graphics context paused', 0);
  });

  wireControls();
  applyTranslations();
  registerServiceWorker();
  wireFileHandlingQueue();

  // Load persisted recent vault & probe Kasa backend in parallel (non-blocking!)
  listRecentModels().then((list) => {
    state.recentModels = list;
    updateModelPopover();
  });
  const backendPromise = probeKasaBackend();

  // Priority model boot chain:
  // 1. Android PWA Share Target
  if (params.get('from_share_target') === '1') {
    const consumed = await consumeShareTargetIfPresent();
    if (consumed) return;
  }

  // 2. Server short share page (/s/<id>)
  const shareMeta = document.querySelector('meta[name="stlviewer-share-id"]');
  const shareNameMeta = document.querySelector('meta[name="stlviewer-share-name"]');
  if (shareMeta?.content) {
    await loadSharedId(shareMeta.content, shareNameMeta?.content, viewState);
    return;
  }

  // 3. Serverless inline gzipped model (#m=...)
  const inlineToken = hashParams.get('m');
  if (inlineToken) {
    const unpacked = await decodeInlineModel(inlineToken);
    if (unpacked.ok) {
      await applyParsedBuffer(unpacked.buffer, unpacked.name, 'inline:hash', { saveToVault: true, viewState });
      return;
    }
  }

  // 4. Remote ?url=...
  const urlParam = params.get('url');
  if (urlParam) {
    await backendPromise;
    await loadFromUrl(urlParam, viewState);
    return;
  }

  // 5. Demo preset ?demo=... or default Flange Housing
  const demoParam = params.get('demo') || 'flange-housing';
  await loadDemoModel(demoParam, viewState);
}

boot();
