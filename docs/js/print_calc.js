/**
 * 3D Printing Estimator, Unit Formatter & Build Plate Fit Diagnostics.
 */

export const MATERIALS = Object.freeze([
  { id: 'pla', name: 'PLA', densityGcm3: 1.24, filamentDiaMm: 1.75 },
  { id: 'petg', name: 'PETG', densityGcm3: 1.27, filamentDiaMm: 1.75 },
  { id: 'abs', name: 'ABS', densityGcm3: 1.04, filamentDiaMm: 1.75 },
  { id: 'asa', name: 'ASA', densityGcm3: 1.07, filamentDiaMm: 1.75 },
  { id: 'tpu', name: 'TPU 95A', densityGcm3: 1.21, filamentDiaMm: 1.75 },
  { id: 'resin', name: 'SLA Resin', densityGcm3: 1.15, filamentDiaMm: 0 },
]);

export const BUILD_PLATES = Object.freeze([
  { id: '220', label: '220 × 220 × 250 mm', x: 220, y: 220, z: 250 },
  { id: '256', label: '256 × 256 × 256 mm', x: 256, y: 256, z: 256 },
  { id: '180', label: '180 × 180 × 180 mm', x: 180, y: 180, z: 180 },
  { id: '300', label: '300 × 300 × 300 mm', x: 300, y: 300, z: 300 },
]);

export function estimatePrint(volumeMm3, areaMm2, materialId = 'pla', infillPct = 20, wallThicknessMm = 1.2) {
  const mat = MATERIALS.find((m) => m.id === materialId) || MATERIALS[0];
  const volMm3 = Math.max(0, Number(volumeMm3) || 0);
  const surfMm2 = Math.max(0, Number(areaMm2) || 0);
  const infill = Math.max(0, Math.min(100, Number(infillPct) || 0)) / 100;

  let effectiveVolMm3;
  if (infill >= 0.999 || mat.id === 'resin') {
    effectiveVolMm3 = volMm3;
  } else {
    const shellVol = Math.min(volMm3, surfMm2 * wallThicknessMm);
    const coreVol = Math.max(0, volMm3 - shellVol);
    effectiveVolMm3 = shellVol + coreVol * infill;
  }

  const effectiveCm3 = effectiveVolMm3 * 0.001;
  const weightGrams = effectiveCm3 * mat.densityGcm3;

  let filamentMeters = 0;
  if (mat.filamentDiaMm > 0) {
    const r = mat.filamentDiaMm * 0.5;
    const crossAreaMm2 = Math.PI * r * r;
    filamentMeters = effectiveVolMm3 / crossAreaMm2 / 1000;
  }

  return {
    material: mat,
    infillPct: Math.round(infill * 100),
    effectiveCm3,
    weightGrams,
    filamentMeters,
  };
}

export function formatDim(mm, unit = 'mm') {
  const v = Number(mm) || 0;
  if (unit === 'cm') return `${(v / 10).toFixed(2)} cm`;
  if (unit === 'in') return `${(v / 25.4).toFixed(2)} in`;
  return `${v.toFixed(1)} mm`;
}

export function formatVolume(mm3, unit = 'mm') {
  const cm3 = (Number(mm3) || 0) * 0.001;
  if (unit === 'in') return `${(cm3 / 16.387064).toFixed(2)} in³`;
  return `${cm3.toFixed(1)} cm³`;
}

export function formatArea(mm2, unit = 'mm') {
  const cm2 = (Number(mm2) || 0) * 0.01;
  if (unit === 'in') return `${(cm2 / 6.4516).toFixed(2)} in²`;
  return `${cm2.toFixed(1)} cm²`;
}

export function checkBedFit(extent, bed = BUILD_PLATES[0]) {
  const ex = Number(extent?.x) || 0;
  const ey = Number(extent?.y) || 0;
  const ez = Number(extent?.z) || 0;
  const fitsNormal = ex <= bed.x && ey <= bed.y && ez <= bed.z;
  const fitsRotated = ey <= bed.x && ex <= bed.y && ez <= bed.z;
  return {
    fits: fitsNormal || fitsRotated,
    rotated: !fitsNormal && fitsRotated,
    bed,
  };
}
