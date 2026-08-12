/* =====================================================================
   Turning a part spec into geometry.

   Split out of world.js for one reason: the assembly solver reasons about
   how big a part is (assembly.js effectiveSize) and this decides how big a
   part actually gets drawn. If those two ever disagree, parts float a
   centimetre off their supports or sink into them, and the cause is
   invisible. Here they can be checked against each other in a test with
   real three.js and no renderer — see test/geometry.test.mjs.
   ===================================================================== */

import * as THREE from 'three';
import { effectiveSize, torusDims } from './assembly.js';

/* A box with its edges knocked off. Raw BoxGeometry has infinitely sharp
   corners, which is the loudest tell that something is a primitive rather
   than a made object — real stock always has a chamfer or a broken edge,
   and it catches the light along every seam. */
export function chamferBox(w, h, d) {
  const r = Math.min(0.03, w * 0.14, h * 0.14, d * 0.14);
  if (r < 0.006) return new THREE.BoxGeometry(w, h, d);

  /* A bevelled extrusion grows in all three directions: bevelSize pushes
     the outline outward in the plane of the shape, bevelThickness adds a
     cap at each end of the extrusion. So the shape has to be drawn UNDER
     size by exactly one bevel on every side for the finished solid to
     measure w × h × d — which it must, because the solver placed it on
     the assumption that it does. */
  const bev = Math.min(r * 0.85, d * 0.22);
  const iw = w - 2 * bev, ih = h - 2 * bev;
  if (iw < 0.004 || ih < 0.004) return new THREE.BoxGeometry(w, h, d);
  const ir = Math.max(0.0005, r - bev);

  const sh = new THREE.Shape();
  const x = iw / 2 - ir, y = ih / 2 - ir;
  sh.moveTo(-x, -ih / 2);
  sh.lineTo(x, -ih / 2); sh.quadraticCurveTo(iw / 2, -ih / 2, iw / 2, -y);
  sh.lineTo(iw / 2, y);  sh.quadraticCurveTo(iw / 2, ih / 2, x, ih / 2);
  sh.lineTo(-x, ih / 2); sh.quadraticCurveTo(-iw / 2, ih / 2, -iw / 2, y);
  sh.lineTo(-iw / 2, -y); sh.quadraticCurveTo(-iw / 2, -ih / 2, -x, -ih / 2);

  const depth = Math.max(0.002, d - 2 * bev);
  const g = new THREE.ExtrudeGeometry(sh, {
    depth, bevelEnabled: true, bevelThickness: bev, bevelSize: bev, bevelSegments: 2, curveSegments: 3
  });
  g.translate(0, 0, -depth / 2);
  g.computeVertexNormals();
  return g;
}

/* Real stock, not tinted lozenges. Physical materials lit by the baked room
   environment — this is what makes a welded bracket read as steel and a
   painted panel read as paint. `tex` is the shared texture bundle built
   once in world.js; the CAD workspace passes the same one in so a part
   looks identical in both views. */
export function partMaterial(kind, color, tex = {}) {
  const tint = c => (color ? new THREE.Color(color) : new THREE.Color(c));
  const map = t => (color ? { map: t, color: new THREE.Color(color) } : { map: t });
  const P = o => new THREE.MeshPhysicalMaterial(o);
  switch ((kind || '').toLowerCase()) {
    case 'metal': case 'steel': case 'aluminium': case 'aluminum':
      return P({ ...map(tex.metal), metalness: 0.92, roughness: 0.3, envMapIntensity: 1.15 });
    case 'painted': case 'paint':
      return P({ color: tint(0x3fa9c9), roughness: 0.42, metalness: 0.02, clearcoat: 0.85, clearcoatRoughness: 0.2, envMapIntensity: 0.95 });
    case 'glass': case 'acrylic':
      return P({ color: tint(0xdfefff), metalness: 0, roughness: 0.05, transmission: 0.92, thickness: 0.35, ior: 1.46, transparent: true, envMapIntensity: 1.3 });
    case 'plastic':
      return P({ color: tint(0xd6453c), roughness: 0.4, metalness: 0, clearcoat: 0.45, clearcoatRoughness: 0.35, envMapIntensity: 0.7 });
    case 'wood':
      return P({ ...map(tex.wood), roughness: 0.72, metalness: 0, envMapIntensity: 0.45 });
    default:
      return P({ ...map(tex.kraft), roughness: 0.95, metalness: 0, envMapIntensity: 0.3 });
  }
}

export function partGeometry(shape, s) {
  const [a, b, c] = s;
  switch ((shape || 'box').toLowerCase()) {
    case 'cylinder': case 'tube': return new THREE.CylinderGeometry(a / 2, a / 2, b, 32);
    case 'cone':     return new THREE.ConeGeometry(a / 2, b, 30);
    case 'sphere': case 'ball': return new THREE.SphereGeometry(a / 2, 32, 20);
    case 'torus': case 'ring': {
      // lying flat, like a ring set down on a bench. Turned on its side by
      // rot [0,0,90] it becomes a wheel, which is what most plans want.
      const { radius, tube } = torusDims(s);
      const g = new THREE.TorusGeometry(radius, tube, 16, 40);
      g.rotateX(Math.PI / 2);
      return g;
    }

    // panels and rods are drawn thinner than they were asked for, and the
    // solver has to reason about the drawn size — so both read it from the
    // same function rather than each keeping its own copy
    case 'panel': case 'plate': {
      const [pw, ph, pd] = effectiveSize('panel', s);
      return chamferBox(pw, ph, pd);
    }
    case 'rod': case 'bar': {
      const [rw, rh] = effectiveSize('rod', s);
      return new THREE.CylinderGeometry(rw / 2, rw / 2, rh, 20);
    }

    case 'wedge': {
      // a real ramp — flat on the bottom, sloped face. (Was a triangular
      // prism standing on a point, which read as a fin.)
      const sh = new THREE.Shape();
      sh.moveTo(-a / 2, -b / 2); sh.lineTo(a / 2, -b / 2); sh.lineTo(-a / 2, b / 2);
      sh.closePath();
      const g = new THREE.ExtrudeGeometry(sh, { depth: c, bevelEnabled: false });
      g.translate(0, 0, -c / 2);
      return g;
    }

    case 'gear': {
      const teeth = 12, rOut = a / 2, rIn = rOut * 0.76;
      const sh = new THREE.Shape();
      for (let i = 0; i < teeth * 2; i++) {
        const r = i % 2 ? rIn : rOut;
        const t = (i / (teeth * 2)) * Math.PI * 2;
        const x = Math.cos(t) * r, y = Math.sin(t) * r;
        i ? sh.lineTo(x, y) : sh.moveTo(x, y);
      }
      sh.closePath();
      const hole = new THREE.Path();
      hole.absarc(0, 0, Math.max(0.03, rOut * 0.18), 0, Math.PI * 2, true);
      sh.holes.push(hole);
      const g = new THREE.ExtrudeGeometry(sh, { depth: b, bevelEnabled: false });
      g.rotateX(Math.PI / 2); g.translate(0, b / 2, 0);
      return g;
    }

    default: return chamferBox(a, b, c);
  }
}
