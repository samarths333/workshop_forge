/* =====================================================================
   The numbers a bench is judged on.

   Up to here the bench could tell you what a part was and what it was
   bolted to, but not what it weighs, how much material it takes, whether
   the thing is going to topple, or how far apart two parts actually are.
   Those are the questions anyone doing real work asks within a minute of
   opening a model, and answering them is what separates a viewer from a
   workspace.

   Everything is derived from the SOLVED assembly and from `effectiveSize`
   — the same numbers the solver laid out and the same numbers shapes.js
   draws — so a mass here always describes the object on screen. Deriving
   volumes from the raw spec instead would quietly disagree with both the
   moment a panel got thinned or a rod got its true diameter.

   Estimates, and honest about it: these are primitives, not solids from a
   kernel, so a torus is a torus and a gear is a cylinder with teeth taken
   off it in one blunt factor. Good to a few percent, which is the right
   accuracy for deciding whether a part is 200g or 2kg.
   ===================================================================== */

import { effectiveSize } from './assembly.js';

/* kg/m³. Ordinary shop stock, not exotic alloys. */
export const DENSITY = {
  metal: 7850,        // mild steel
  alloy: 2700,        // cast and machined aluminium — a third of the steel, which
                      // is the entire reason an engine is made of it
  painted: 7850,      // painted steel — the paint is not the part
  plastic: 1040,      // ABS
  wood: 650,          // beech-ish
  cardboard: 220,     // double-wall corrugated
  glass: 2500
};

const PI = Math.PI;

/* ------------------------------------------------------------------ */
/* one part                                                            */
/* ------------------------------------------------------------------ */
export function volumeOf(shape, size) {
  const [w, h, d] = effectiveSize(shape, size).map(v => Math.max(0, v));
  const r = w / 2;

  switch ((shape || 'box').toLowerCase()) {
    case 'sphere': case 'ball':   return (4 / 3) * PI * r ** 3;
    case 'cone':                  return (1 / 3) * PI * r * r * h;
    case 'cylinder':              return PI * r * r * h;
    case 'rod': case 'bar':       return PI * r * r * h;
    case 'gear':                  return PI * r * r * h * 0.82;          // teeth take a bite out
    case 'tube':                  return PI * h * (r * r - (r * 0.7) ** 2);
    case 'wedge':                 return w * h * d * 0.5;
    case 'torus': case 'ring': {
      // described as [outer diameter, thickness]: a ring of radius R made
      // of stock of radius r
      const tr = Math.max(0.001, Math.min(size[1], size[0]) / 2);
      const R = Math.max(tr, (size[0] - size[1]) / 2);
      return 2 * PI * PI * R * tr * tr;
    }
    default:                      return w * h * d;                       // box, panel, plate
  }
}

export function areaOf(shape, size) {
  const [w, h, d] = effectiveSize(shape, size).map(v => Math.max(0, v));
  const r = w / 2;

  switch ((shape || 'box').toLowerCase()) {
    case 'sphere': case 'ball':   return 4 * PI * r * r;
    case 'cone':                  return PI * r * (r + Math.hypot(r, h));
    case 'cylinder': case 'rod': case 'bar': case 'gear': case 'tube':
      return 2 * PI * r * (r + h);
    case 'torus': case 'ring': {
      const tr = Math.max(0.001, Math.min(size[1], size[0]) / 2);
      const R = Math.max(tr, (size[0] - size[1]) / 2);
      return 4 * PI * PI * R * tr;
    }
    default:                      return 2 * (w * h + h * d + w * d);
  }
}

export const densityOf = material => DENSITY[String(material || '').toLowerCase()] ?? DENSITY.plastic;

/* One solved instance — the fit scale matters, because a build scaled to
   88% to fit the pedestal weighs 0.88³ of what its numbers say. */
export function partMetrics(inst) {
  const s = inst.scale || 1;
  const volume = volumeOf(inst.shape, inst.size) * s ** 3;
  const area = areaOf(inst.shape, inst.size) * s ** 2;
  const density = densityOf(inst.material);
  return { volume, area, density, mass: volume * density };
}

/* ------------------------------------------------------------------ */
/* the whole assembly                                                  */
/* ------------------------------------------------------------------ */
export function assemblyMetrics(solved) {
  const empty = {
    parts: 0, volume: 0, area: 0, mass: 0, com: [0, 0, 0],
    size: [0, 0, 0], footprint: [0, 0], byMaterial: [], stable: true, tipRatio: 0
  };
  if (!solved?.instances?.length) return empty;

  let volume = 0, area = 0, mass = 0;
  const com = [0, 0, 0];
  const byMat = new Map();

  for (const inst of solved.instances) {
    const m = partMetrics(inst);
    volume += m.volume; area += m.area; mass += m.mass;
    for (let a = 0; a < 3; a++) com[a] += inst.pos[a] * m.mass;
    const cur = byMat.get(inst.material) || { material: inst.material, parts: 0, volume: 0, mass: 0 };
    cur.parts++; cur.volume += m.volume; cur.mass += m.mass;
    byMat.set(inst.material, cur);
  }
  if (mass > 0) for (let a = 0; a < 3; a++) com[a] /= mass;

  const b = solved.bounds;
  const size = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];

  /* Will it stand up? Everything that touches the ground defines the base;
     if the centre of mass sits outside that footprint the object topples,
     and a bench that does not say so is letting you export a design that
     falls over. */
  const ground = solved.instances.filter(i => i.pos[1] - i.half[1] < 0.02);
  const foot = ground.length ? {
    minX: Math.min(...ground.map(i => i.pos[0] - i.half[0])),
    maxX: Math.max(...ground.map(i => i.pos[0] + i.half[0])),
    minZ: Math.min(...ground.map(i => i.pos[2] - i.half[2])),
    maxZ: Math.max(...ground.map(i => i.pos[2] + i.half[2]))
  } : { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };

  const halfX = (foot.maxX - foot.minX) / 2 || 1e-6;
  const halfZ = (foot.maxZ - foot.minZ) / 2 || 1e-6;
  const offX = Math.abs(com[0] - (foot.maxX + foot.minX) / 2) / halfX;
  const offZ = Math.abs(com[2] - (foot.maxZ + foot.minZ) / 2) / halfZ;
  const tipRatio = Math.max(offX, offZ);

  return {
    parts: solved.instances.length,
    volume, area, mass, com, size,
    footprint: [foot.maxX - foot.minX, foot.maxZ - foot.minZ],
    byMaterial: [...byMat.values()].sort((a, b2) => b2.mass - a.mass),
    stable: tipRatio <= 1,
    tipRatio
  };
}

/* ------------------------------------------------------------------ */
/* two parts                                                           */
/* ------------------------------------------------------------------ */
/* Centre to centre is the easy number and rarely the useful one. What a
   person measuring on a bench actually wants is the CLEARANCE: how much
   air is between these two, and on which axis they are closest to fouling
   each other. A negative gap means they are already interfering. */
export function measureBetween(a, b) {
  if (!a || !b) return null;
  const delta = [0, 1, 2].map(i => b.pos[i] - a.pos[i]);
  const centre = Math.hypot(...delta);
  const gaps = [0, 1, 2].map(i => Math.abs(delta[i]) - (a.half[i] + b.half[i]));

  // separated along whichever axis has the most air between them; if none
  // has any, they interfere and the shallowest overlap is the one to fix
  const gap = Math.max(...gaps);
  const axis = gaps.indexOf(gap);
  return {
    centre,
    delta,
    gap,
    axis,
    axisName: ['X', 'Y', 'Z'][axis],
    touching: Math.abs(gap) < 0.004,
    interfering: gap < -0.004
  };
}

/* ------------------------------------------------------------------ */
/* the parts list                                                      */
/* ------------------------------------------------------------------ */
/* Grouped the way a shop would order it: one line per part the plan makes,
   with the quantity the arrays expanded to. */
export function bom(solved, parts = []) {
  if (!solved?.instances?.length) return [];
  const rows = new Map();

  for (const inst of solved.instances) {
    const key = inst.src;
    const row = rows.get(key);
    if (row) { row.qty++; row.mass += partMetrics(inst).mass; row.volume += partMetrics(inst).volume; continue; }
    const m = partMetrics(inst);
    const spec = parts[inst.src];
    rows.set(key, {
      item: rows.size + 1,
      name: spec?.name || inst.name,
      shape: inst.shape,
      material: inst.material,
      qty: 1,
      size: effectiveSize(inst.shape, inst.size).map(v => v * (inst.scale || 1)),
      volume: m.volume,
      mass: m.mass,
      attachedTo: inst.parent != null ? (parts[solved.instances.find(x => x.i === inst.parent)?.src]?.name || '—') : 'ground',
      face: inst.face || '—'
    });
  }
  return [...rows.values()];
}

export function bomCSV(rows, { unit = 'mm' } = {}) {
  const q = v => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const head = ['item', 'qty', 'name', 'shape', 'material',
    `width (${unit})`, `height (${unit})`, `depth (${unit})`,
    'volume (cm3)', 'mass (g)', 'attached to', 'face'];
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push([
      r.item, r.qty, r.name, r.shape, r.material,
      ...r.size.map(v => +toUnit(v, unit).toFixed(2)),
      +(r.volume * 1e6).toFixed(1),
      +(r.mass * 1000).toFixed(1),
      r.attachedTo, r.face
    ].map(q).join(','));
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* units — the shop thinks in metres, people think in millimetres      */
/* ------------------------------------------------------------------ */
export const UNITS = ['mm', 'cm', 'm'];
const PER_METRE = { mm: 1000, cm: 100, m: 1 };
const DECIMALS = { mm: 1, cm: 2, m: 3 };

export const toUnit = (metres, unit = 'mm') => metres * (PER_METRE[unit] ?? 1000);
export const fromUnit = (value, unit = 'mm') => value / (PER_METRE[unit] ?? 1000);

export function formatLen(metres, unit = 'mm', withUnit = true) {
  if (!Number.isFinite(metres)) return '—';
  const v = toUnit(metres, unit);
  const s = v.toFixed(DECIMALS[unit] ?? 1).replace(/\.?0+$/, '');
  return withUnit ? `${s} ${unit}` : s;
}

/* Accepts what people actually type: "42", "42mm", "4.2 cm", "0.042 m".
   An explicit suffix wins over the panel's current unit, because someone
   who typed the unit meant it. */
export function parseLen(text, unit = 'mm') {
  const s = String(text).trim().toLowerCase();
  const m = s.match(/^(-?\d*\.?\d+)\s*(mm|cm|m)?$/);
  if (!m) return null;
  return fromUnit(parseFloat(m[1]), m[2] || unit);
}

export function formatMass(kg) {
  if (!Number.isFinite(kg)) return '—';
  if (kg < 0.001) return `${(kg * 1e6).toFixed(0)} mg`;
  if (kg < 1) return `${(kg * 1000).toFixed(kg < 0.01 ? 1 : 0)} g`;
  return `${kg.toFixed(kg < 10 ? 2 : 1)} kg`;
}

export function formatVolume(m3) {
  if (!Number.isFinite(m3)) return '—';
  const cm3 = m3 * 1e6;
  if (cm3 < 1000) return `${cm3.toFixed(cm3 < 10 ? 2 : 0)} cm³`;
  return `${(m3 * 1000).toFixed(2)} L`;
}
