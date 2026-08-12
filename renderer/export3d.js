/* =====================================================================
   Getting the thing out of the shop.

   Rivet looks up how people actually make an object, builds it, and stands
   it on a pedestal — and until now that was the end of it. The object only
   existed as pixels. This turns what is standing on the pedestal into a
   file: STL for a slicer, OBJ for anything else.

   Deliberately dumb about geometry: it is handed triangles that three.js
   already tessellated and it writes bytes. That keeps it free of imports —
   same rule as assembly.js, skills.js and history.js — so the writers can
   be checked in node against known triangle counts and byte lengths rather
   than by opening the result in a slicer and squinting at it.

   Two conventions worth stating, because getting them wrong is the classic
   way an export "works" and is still useless:

   UNITS. The shop thinks in metres. STL carries no units at all, and every
   slicer on earth assumes millimetres, so a 0.4m part exported raw imports
   as a speck 0.4mm across. Everything is scaled by 1000 on the way out.

   UP. three.js is Y-up. Printers, and therefore STL, are Z-up. An export
   that skips the rotation lands on its side in the slicer and has to be
   re-oriented by hand every time, so STL gets the swap and OBJ — read by
   DCC tools that are mostly Y-up — does not.
   ===================================================================== */

/* metres → millimetres */
export const MM = 1000;

/* Below this a triangle has no area worth writing. Slicers either warn
   about degenerate facets or silently produce a non-manifold mesh, and
   tessellating a cone tip reliably produces a few. */
const AREA_EPS = 1e-9;

/* ------------------------------------------------------------------ */
/* triangles                                                           */
/* ------------------------------------------------------------------ */
/* One drawn mesh → a flat run of triangle vertices in assembly space.

   `matrix` is a three.js Matrix4.elements, i.e. column-major:
     x' = e0·x + e4·y + e8·z + e12
   `position` and `index` are the raw typed arrays off the geometry, so
   nothing here needs to know what a BufferGeometry is. */
export function trianglesFrom({ position, index = null, matrix = null }) {
  const src = index ? index.length : position.length / 3;
  const out = new Float32Array(src * 3);
  const e = matrix;

  for (let i = 0; i < src; i++) {
    const v = (index ? index[i] : i) * 3;
    const x = position[v], y = position[v + 1], z = position[v + 2];
    const o = i * 3;
    if (e) {
      out[o]     = e[0] * x + e[4] * y + e[8]  * z + e[12];
      out[o + 1] = e[1] * x + e[5] * y + e[9]  * z + e[13];
      out[o + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    } else {
      out[o] = x; out[o + 1] = y; out[o + 2] = z;
    }
  }
  return out;
}

/* Scale, optionally swing Y-up round to Z-up, and drop anything with no
   area. Shared by both writers so the two files describe the same solid. */
function prepare(groups, { scale = MM, zUp = false } = {}) {
  const out = [];
  let total = 0;

  for (const g of groups || []) {
    const tris = g.tris || g.triangles;
    if (!tris || tris.length < 9) continue;
    const keep = [];

    for (let i = 0; i + 8 < tris.length; i += 9) {
      const p = new Array(9);
      for (let k = 0; k < 9; k += 3) {
        const x = tris[i + k] * scale, y = tris[i + k + 1] * scale, z = tris[i + k + 2] * scale;
        // Y-up → Z-up is a −90° turn about X: (x, y, z) → (x, −z, y)
        if (zUp) { p[k] = x; p[k + 1] = -z; p[k + 2] = y; }
        else     { p[k] = x; p[k + 1] = y;  p[k + 2] = z; }
      }
      const n = faceNormal(p);
      if (!n) continue;                       // zero area — not a triangle
      keep.push({ p, n });
    }

    if (!keep.length) continue;
    total += keep.length;
    out.push({ name: safeName(g.name, out.length), tris: keep });
  }
  return { groups: out, total };
}

function faceNormal(p) {
  const ax = p[3] - p[0], ay = p[4] - p[1], az = p[5] - p[2];
  const bx = p[6] - p[0], by = p[7] - p[1], bz = p[8] - p[2];
  const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  const len = Math.hypot(nx, ny, nz);
  if (!(len > AREA_EPS)) return null;
  return [nx / len, ny / len, nz / len];
}

const safeName = (name, i) =>
  String(name || `part_${i + 1}`).trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48)
  || `part_${i + 1}`;

/* ------------------------------------------------------------------ */
/* STL — binary, because ASCII STL is five times the size for nothing  */
/* ------------------------------------------------------------------ */
/*   80  byte header, free text, ignored by readers
      4  byte uint32 triangle count
     50  bytes per triangle: normal xyz, three vertices xyz, uint16 attr
   All little-endian. The header must not start with "solid" or some
   readers will try to parse the file as ASCII. */
export function toSTL(groups, opts = {}) {
  const { groups: g, total } = prepare(groups, { zUp: true, ...opts });
  const buf = new ArrayBuffer(84 + total * 50);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  const banner = `Workshop Forge export - ${total} facets - millimetres, Z up`;
  for (let i = 0; i < 80; i++) bytes[i] = i < banner.length ? banner.charCodeAt(i) & 0x7f : 0x20;
  view.setUint32(80, total, true);

  let o = 84;
  for (const part of g) {
    for (const { p, n } of part.tris) {
      view.setFloat32(o, n[0], true); view.setFloat32(o + 4, n[1], true); view.setFloat32(o + 8, n[2], true);
      for (let k = 0; k < 9; k++) view.setFloat32(o + 12 + k * 4, p[k], true);
      view.setUint16(o + 48, 0, true);
      o += 50;
    }
  }
  return bytes;
}

/* ------------------------------------------------------------------ */
/* OBJ — one object per part, so the assembly opens as an assembly     */
/* ------------------------------------------------------------------ */
export function toOBJ(groups, opts = {}) {
  const { groups: g, total } = prepare(groups, { zUp: false, ...opts });
  const lines = [
    '# Workshop Forge',
    `# ${g.length} parts, ${total} triangles, millimetres, Y up`,
    ''
  ];

  let vBase = 1, nBase = 1;
  for (const part of g) {
    // dedup inside a part but never across parts: two parts that touch are
    // still two solids, and welding them here would be a lie about the build
    const vIndex = new Map(), nIndex = new Map();
    const verts = [], norms = [], faces = [];

    const idOf = (map, list, key, vals) => {
      let id = map.get(key);
      if (id === undefined) { id = list.length; list.push(vals); map.set(key, id); }
      return id;
    };

    for (const { p, n } of part.tris) {
      const nk = n.map(q => q.toFixed(4)).join(',');
      const ni = idOf(nIndex, norms, nk, n) + nBase;
      const f = [];
      for (let k = 0; k < 9; k += 3) {
        const v = [p[k], p[k + 1], p[k + 2]];
        const vk = v.map(q => q.toFixed(4)).join(',');
        f.push(`${idOf(vIndex, verts, vk, v) + vBase}//${ni}`);
      }
      faces.push('f ' + f.join(' '));
    }

    lines.push(`o ${part.name}`, `g ${part.name}`);
    for (const v of verts) lines.push(`v ${fmt(v[0])} ${fmt(v[1])} ${fmt(v[2])}`);
    for (const n of norms) lines.push(`vn ${fmt(n[0])} ${fmt(n[1])} ${fmt(n[2])}`);
    lines.push(...faces, '');
    vBase += verts.length;
    nBase += norms.length;
  }
  return lines.join('\n');
}

const fmt = v => (Math.abs(v) < 1e-6 ? 0 : +v.toFixed(4)).toString();

/* What is about to be written, for the log line and for the button state. */
export function summarise(groups, opts = {}) {
  const { groups: g, total } = prepare(groups, opts);
  return {
    parts: g.length,
    triangles: total,
    stlBytes: 84 + total * 50
  };
}
