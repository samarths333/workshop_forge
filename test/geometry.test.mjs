/* The one place the whole thing can quietly come apart.

   assembly.js decides where a part goes based on how big it thinks the
   part is; shapes.js decides how big the part actually gets drawn. If
   those drift, every build looks subtly wrong — parts hovering a
   centimetre above their supports, or sunk into them — and nothing errors.

   So: build every shape with real three.js, measure the mesh, and compare
   it to what the solver assumed. No renderer needed, three.js only touches
   WebGL when you ask it to draw something.
*/
import * as THREE from 'three';
import { partGeometry, chamferBox } from '../renderer/shapes.js';
import { effectiveSize, halfExtents, SHAPES, solveAssembly } from '../renderer/assembly.js';
import { trianglesFrom, toSTL } from '../renderer/export3d.js';

const LAMP = [
  { name: 'base', shape: 'cylinder', material: 'metal', size: [0.5, 0.12, 0.5] },
  { name: 'stem', shape: 'rod', material: 'metal', size: [0.14, 0.8, 0.14], attach: { to: 0, face: 'top' } },
  { name: 'shade', shape: 'cone', material: 'painted', size: [0.44, 0.32, 0.44], attach: { to: 1, face: 'top' } }
];

let pass = 0, fail = 0;
const out = [];
const check = (name, fn) => {
  try { fn(); pass++; out.push(`  ok    ${name}`); }
  catch (e) { fail++; out.push(`  FAIL  ${name}\n          ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

function measure(shape, size) {
  const g = partGeometry(shape, size);
  g.computeBoundingBox();
  const b = g.boundingBox;
  return {
    size: [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z],
    centre: [(b.max.x + b.min.x) / 2, (b.max.y + b.min.y) / 2, (b.max.z + b.min.z) / 2]
  };
}

const SIZES = [
  [0.5, 0.5, 0.5], [1.2, 0.08, 0.9], [0.14, 0.8, 0.14],
  [0.44, 1.5, 0.44], [2.4, 0.2, 0.3], [0.16, 0.16, 0.16]
];

check('what gets drawn is the size the solver assumed', () => {
  const bad = [];
  for (const shape of SHAPES) {
    for (const size of SIZES) {
      const want = effectiveSize(shape, size);
      const got = measure(shape, size).size;
      for (let ax = 0; ax < 3; ax++) {
        const slack = Math.max(0.02, want[ax] * 0.06);
        if (Math.abs(got[ax] - want[ax]) > slack) {
          bad.push(`${shape} ${size.join('x')} axis ${'xyz'[ax]}: solver assumed ${want[ax].toFixed(3)}, mesh is ${got[ax].toFixed(3)}`);
        }
      }
    }
  }
  assert(!bad.length, bad.slice(0, 8).join('\n          '));
});

check('every shape is centred on its own origin', () => {
  const bad = [];
  for (const shape of SHAPES) {
    for (const size of SIZES) {
      const c = measure(shape, size).centre;
      const scale = Math.max(...effectiveSize(shape, size));
      for (let ax = 0; ax < 3; ax++) {
        if (Math.abs(c[ax]) > Math.max(0.015, scale * 0.04)) {
          bad.push(`${shape} ${size.join('x')} sits ${c[ax].toFixed(3)} off centre on ${'xyz'[ax]}`);
        }
      }
    }
  }
  // the solver puts a part's CENTRE at inst.pos, so a geometry whose mass
  // is not centred on its origin lands in the wrong place
  assert(!bad.length, bad.slice(0, 8).join('\n          '));
});

check('the chamfer comes out the exact size it was asked for', () => {
  for (const [w, h, d] of [[0.5, 0.5, 0.5], [1.2, 0.08, 0.9], [0.2, 1.4, 0.2], [0.05, 0.42, 0.5]]) {
    const g = chamferBox(w, h, d);
    g.computeBoundingBox();
    const b = g.boundingBox;
    const got = [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z];
    [w, h, d].forEach((want, ax) => {
      assert(Math.abs(got[ax] - want) < 0.004,
        `chamferBox(${w},${h},${d}) came out ${got[ax].toFixed(4)} on ${'xyz'[ax]}, wanted ${want}`);
    });
  }
});

check('geometry is real: no NaN vertices, sane triangle counts', () => {
  for (const shape of SHAPES) {
    const g = partGeometry(shape, [0.6, 0.5, 0.4]);
    const pos = g.attributes.position;
    assert(pos && pos.count > 3, `${shape} produced ${pos ? pos.count : 0} vertices`);
    assert(pos.count < 20000, `${shape} produced ${pos.count} vertices — too heavy for a part`);
    for (let i = 0; i < pos.array.length; i++) {
      assert(Number.isFinite(pos.array[i]), `${shape} has a NaN vertex`);
    }
    assert(g.attributes.normal, `${shape} has no normals — it will render black`);
  }
});

check('a solved lamp measures up as a lamp when actually built', () => {
  const solved = solveAssembly([
    { name: 'base', shape: 'cylinder', material: 'metal', size: [0.5, 0.12, 0.5] },
    { name: 'stem', shape: 'rod', material: 'metal', size: [0.14, 0.8, 0.14], attach: { to: 0, face: 'top' } },
    { name: 'shade', shape: 'cone', material: 'painted', size: [0.44, 0.32, 0.44], attach: { to: 1, face: 'top' } }
  ]);

  // build it for real and check the meshes touch where the solver said
  const meshes = solved.instances.map(inst => {
    const m = new THREE.Mesh(partGeometry(inst.shape, inst.size));
    m.position.set(...inst.pos);
    m.rotation.set(...inst.rot);
    m.scale.setScalar(inst.scale || 1);
    m.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(m);
    return { inst, bb };
  });

  assert(Math.abs(meshes[0].bb.min.y) < 0.01, `the base is ${meshes[0].bb.min.y.toFixed(3)} off the pedestal`);
  assert(Math.abs(meshes[1].bb.min.y - meshes[0].bb.max.y) < 0.02, 'the real stem mesh does not meet the real base mesh');
  assert(Math.abs(meshes[2].bb.min.y - meshes[1].bb.max.y) < 0.02, 'the real shade mesh does not meet the real stem mesh');
  const total = meshes[2].bb.max.y;
  assert(Math.abs(total - 1.24) < 0.06, `the finished lamp stands ${total.toFixed(2)}m, expected about 1.24m`);
});

/* ------------------------------------------------------------------ */
/* rotated bounds — the hitbox has to follow the shape                 */
/* ------------------------------------------------------------------ */
/* Measure the real vertices of a rotated mesh and compare them to what
   the solver assumed. Two ways to fail: too small and parts intersect
   with nothing to explain it, too large and the solver shoves neighbours
   away from a part that has not moved. */
function trueHalfExtents(shape, size, rot) {
  const g = partGeometry(shape, size);
  const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rot[0], rot[1], rot[2], 'XYZ'));
  const pos = g.attributes.position;
  const v = new THREE.Vector3();
  const half = [0, 0, 0];
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(m);
    half[0] = Math.max(half[0], Math.abs(v.x));
    half[1] = Math.max(half[1], Math.abs(v.y));
    half[2] = Math.max(half[2], Math.abs(v.z));
  }
  return half;
}

const D = d => (d * Math.PI) / 180;
const ROTS = [
  [0, 0, 0], [0, D(45), 0], [0, D(90), 0], [0, D(30), 0],
  [0, 0, D(90)], [0, 0, D(45)], [D(90), 0, 0], [D(45), 0, D(45)],
  [D(30), D(60), D(15)], [D(-70), D(20), D(130)]
];

check('a turned shape keeps the hitbox of the shape, not of its box', () => {
  const bad = [];
  for (const shape of SHAPES) {
    for (const size of [[0.5, 0.5, 0.5], [0.44, 1.5, 0.44], [0.14, 0.8, 0.14], [1.2, 0.08, 0.9]]) {
      for (const rot of ROTS) {
        const want = halfExtents(shape, size, rot);
        const real = trueHalfExtents(shape, size, rot);
        for (let ax = 0; ax < 3; ax++) {
          if (want[ax] < real[ax] - 0.012) {
            bad.push(`${shape} ${size.join('x')} @${rot.map(r => Math.round(r * 57.3)).join(',')}° ${'xyz'[ax]}: solver says ${want[ax].toFixed(3)}, mesh reaches ${real[ax].toFixed(3)} — parts will intersect`);
          }
          if (want[ax] > real[ax] * 1.35 + 0.02) {
            bad.push(`${shape} ${size.join('x')} @${rot.map(r => Math.round(r * 57.3)).join(',')}° ${'xyz'[ax]}: solver says ${want[ax].toFixed(3)} but the mesh is only ${real[ax].toFixed(3)} — the hitbox is inflated`);
          }
        }
      }
    }
  }
  assert(!bad.length, bad.slice(0, 6).join('\n          '));
});

check('spinning a round part about its own axis does not change its bounds', () => {
  // this is the one that was visibly wrong: turn a cone and the box grew
  for (const shape of ['cone', 'cylinder', 'rod', 'sphere', 'torus', 'gear']) {
    const size = [0.5, 0.7, 0.5];
    const rest = halfExtents(shape, size, [0, 0, 0]);
    for (const deg of [15, 30, 45, 90, 137]) {
      const spun = halfExtents(shape, size, [0, D(deg), 0]);
      for (let ax = 0; ax < 3; ax++) {
        assert(Math.abs(spun[ax] - rest[ax]) < 0.004,
          `${shape} turned ${deg}° about its own axis: ${'xyz'[ax]} went from ${rest[ax].toFixed(3)} to ${spun[ax].toFixed(3)}`);
      }
    }
  }
});

check('a ball is the same ball whichever way it is turned', () => {
  const a = halfExtents('sphere', [0.6, 0.6, 0.6], [0, 0, 0]);
  const b = halfExtents('sphere', [0.6, 0.6, 0.6], [D(37), D(51), D(19)]);
  assert(Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9,
    `a rotated sphere grew from ${a[0].toFixed(3)} to ${b[0].toFixed(3)}`);
});

/* ------------------------------------------------------------------ */
/* the export, joined up with real three.js matrices                   */
/* ------------------------------------------------------------------ */
/* export3d.js takes a Matrix4's `elements` on faith. Column-major is easy
   to get subtly wrong — a transposed matrix still produces a plausible
   file, just with every part in the wrong place — so this builds the real
   meshes, lets three.js compose the real matrices, and measures what comes
   out of the writer against what the solver said it laid out. */
check('what comes out of the exporter is what the solver laid out', () => {
  const solved = solveAssembly(LAMP);
  const group = new THREE.Group();
  for (const inst of solved.instances) {
    const m = new THREE.Mesh(partGeometry(inst.shape, inst.size));
    m.position.set(...inst.pos);
    m.rotation.set(...inst.rot);
    const s = inst.scale || 1;
    m.scale.set(s, s, s);
    group.add(m);
  }
  group.updateMatrixWorld(true);

  const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
  const local = new THREE.Matrix4();
  const groups = group.children.map((o, i) => {
    local.copy(inv).multiply(o.matrixWorld);
    return {
      name: `p${i}`,
      tris: trianglesFrom({
        position: o.geometry.attributes.position.array,
        index: o.geometry.index ? o.geometry.index.array : null,
        matrix: local.elements.slice()
      })
    };
  });

  // three.js's own answer for the same assembly
  const want = new THREE.Box3().setFromObject(group);
  const stl = toSTL(groups);
  const dv = new DataView(stl.buffer, stl.byteOffset, stl.byteLength);
  const n = dv.getUint32(80, true);
  assert(n > 100, `only ${n} facets for a three-part lamp`);

  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let f = 0; f < n; f++) {
    for (let v = 0; v < 3; v++) {
      for (let a = 0; a < 3; a++) {
        const q = dv.getFloat32(84 + f * 50 + 12 + v * 12 + a * 4, true);
        lo[a] = Math.min(lo[a], q); hi[a] = Math.max(hi[a], q);
      }
    }
  }
  // STL is millimetres and Z-up: (x, y, z) → (x, −z, y)
  const near = (a, b, m) => assert(Math.abs(a - b) < 0.5, `${m}: ${a.toFixed(2)} vs ${b.toFixed(2)}`);
  near(hi[0] - lo[0], (want.max.x - want.min.x) * 1000, 'width came out wrong');
  near(hi[2] - lo[2], (want.max.y - want.min.y) * 1000, 'height did not become Z');
  near(hi[1] - lo[1], (want.max.z - want.min.z) * 1000, 'depth did not become −Y');
  near(lo[2], want.min.y * 1000, 'the export does not start where the assembly starts');
});

console.log(out.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
