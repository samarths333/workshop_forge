import * as THREE from 'three';

const M = {
  steel:  new THREE.MeshStandardMaterial({ color: 0xb9c0c8, metalness: 0.85, roughness: 0.32 }),
  dark:   new THREE.MeshStandardMaterial({ color: 0x2c3038, metalness: 0.5,  roughness: 0.6 }),
  handle: new THREE.MeshStandardMaterial({ color: 0xd6453c, roughness: 0.75 }),
  handle2:new THREE.MeshStandardMaterial({ color: 0x2f7fd6, roughness: 0.75 }),
  wood:   new THREE.MeshStandardMaterial({ color: 0xb07c47, roughness: 0.9  }),
  kraft:  new THREE.MeshStandardMaterial({ color: 0xc69a63, roughness: 0.95 }),
  black:  new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.7  }),
  glass:  new THREE.MeshStandardMaterial({ color: 0x8fd4e8, transparent: true, opacity: 0.45, roughness: 0.1 }),
  yellow: new THREE.MeshStandardMaterial({ color: 0xf2c14e, roughness: 0.6  }),
  white:  new THREE.MeshStandardMaterial({ color: 0xe8e8e6, roughness: 0.8  }),
  paint:  new THREE.MeshStandardMaterial({ color: 0x3fa9c9, roughness: 0.6  })
};

const box  = (w, h, d, m, x = 0, y = 0, z = 0) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y, z); return o; };
const cyl  = (r1, r2, h, m, x = 0, y = 0, z = 0, seg = 12) => { const o = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, h, seg), m); o.position.set(x, y, z); return o; };
const sph  = (r, m, x = 0, y = 0, z = 0) => { const o = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 10), m); o.position.set(x, y, z); return o; };
const grp  = (...kids) => { const g = new THREE.Group(); kids.forEach(k => g.add(k)); return g; };

/* Every prop is authored so the grip sits at the group origin,
   the working end points along +Y, so the hand can just hold it. */
export const PROPS = {
  scissors: () => {
    const g = grp(
      box(0.03, 0.34, 0.012, M.steel, -0.02, 0.19, 0),
      box(0.03, 0.34, 0.012, M.steel,  0.02, 0.19, 0.012),
      cyl(0.052, 0.052, 0.02, M.handle, -0.035, -0.05, 0, 14),
      cyl(0.052, 0.052, 0.02, M.handle,  0.035, -0.05, 0.012, 14),
      sph(0.018, M.dark, 0, 0.03, 0.006)
    );
    g.children[2].rotation.x = Math.PI / 2; g.children[3].rotation.x = Math.PI / 2;
    return g;
  },
  boxcutter: () => grp(box(0.045, 0.2, 0.022, M.yellow, 0, 0.04, 0), box(0.028, 0.1, 0.004, M.steel, 0, 0.19, 0)),
  marker:    () => grp(cyl(0.022, 0.022, 0.19, M.black, 0, 0.06, 0), cyl(0.014, 0.005, 0.05, M.dark, 0, 0.18, 0)),
  ruler:     () => grp(box(0.05, 0.52, 0.008, M.yellow, 0, 0.16, 0)),
  tapemeasure: () => grp(box(0.11, 0.11, 0.055, M.yellow, 0, 0.02, 0), box(0.028, 0.24, 0.004, M.steel, 0, 0.18, 0)),
  gluegun:   () => grp(box(0.06, 0.13, 0.16, M.paint, 0, 0.05, 0.02), cyl(0.018, 0.01, 0.1, M.steel, 0, 0.16, 0.03), box(0.045, 0.09, 0.03, M.dark, 0, -0.03, -0.03)),
  taperoll:  () => { const t = new THREE.Mesh(new THREE.TorusGeometry(0.085, 0.032, 8, 20), M.kraft); t.rotation.y = Math.PI / 2; t.position.y = 0.1; return grp(t); },
  holepunch: () => grp(box(0.09, 0.14, 0.09, M.handle, 0, 0.05, 0), cyl(0.014, 0.014, 0.09, M.steel, 0, 0.16, 0)),
  bonefolder:() => grp(box(0.035, 0.26, 0.012, M.white, 0, 0.12, 0)),

  torch:     () => grp(cyl(0.03, 0.03, 0.2, M.dark, 0, 0.06, 0), cyl(0.022, 0.01, 0.12, M.steel, 0, 0.21, 0), box(0.05, 0.06, 0.05, M.handle, 0, -0.05, 0.02)),
  stinger:   () => grp(cyl(0.032, 0.032, 0.22, M.black, 0, 0.07, 0), cyl(0.008, 0.008, 0.22, M.steel, 0, 0.28, 0)),
  grinder:   () => { const d = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.014, 20), M.dark); d.rotation.z = Math.PI / 2; d.position.set(0, 0.3, 0); return grp(cyl(0.05, 0.05, 0.26, M.handle2, 0, 0.08, 0), box(0.1, 0.09, 0.07, M.dark, 0, 0.24, 0), d); },
  hammer:    () => grp(cyl(0.024, 0.028, 0.34, M.wood, 0, 0.1, 0), box(0.07, 0.075, 0.19, M.steel, 0, 0.3, 0)),
  mallet:    () => grp(cyl(0.024, 0.028, 0.32, M.wood, 0, 0.1, 0), cyl(0.06, 0.06, 0.2, M.white, 0, 0.29, 0, 14)),
  hacksaw:   () => grp(box(0.05, 0.1, 0.05, M.handle2, 0, -0.02, 0), box(0.02, 0.44, 0.02, M.steel, 0, 0.22, -0.06), box(0.008, 0.42, 0.05, M.steel, 0, 0.1, 0)),
  drill:     () => grp(box(0.09, 0.16, 0.22, M.handle2, 0, 0, 0.02), cyl(0.028, 0.02, 0.22, M.steel, 0, 0.19, 0.04), box(0.08, 0.09, 0.1, M.dark, 0, -0.13, -0.02)),
  file:      () => grp(cyl(0.026, 0.02, 0.1, M.wood, 0, -0.02, 0), box(0.026, 0.34, 0.014, M.steel, 0, 0.2, 0)),
  wrench:    () => grp(box(0.038, 0.34, 0.016, M.steel, 0, 0.14, 0), box(0.1, 0.07, 0.018, M.steel, 0, 0.31, 0), box(0.1, 0.03, 0.02, M.steel, 0, 0.36, 0)),
  screwdriver: () => grp(cyl(0.032, 0.026, 0.15, M.handle, 0, 0.02, 0), cyl(0.011, 0.011, 0.22, M.steel, 0, 0.2, 0), box(0.024, 0.02, 0.006, M.steel, 0, 0.31, 0)),
  rivetgun:  () => grp(box(0.06, 0.24, 0.06, M.steel, 0, 0.1, 0), box(0.05, 0.13, 0.05, M.handle, 0, -0.06, 0.03), cyl(0.014, 0.014, 0.07, M.dark, 0, 0.25, 0)),
  tongs:     () => grp(box(0.02, 0.4, 0.02, M.steel, -0.03, 0.2, 0), box(0.02, 0.4, 0.02, M.steel, 0.03, 0.2, 0), box(0.06, 0.06, 0.05, M.steel, 0, 0.42, 0)),
  pliers:    () => grp(box(0.026, 0.18, 0.016, M.handle, -0.02, 0.02, 0), box(0.026, 0.18, 0.016, M.handle2, 0.02, 0.02, 0), box(0.05, 0.14, 0.02, M.steel, 0, 0.18, 0)),
  clamp:     () => grp(box(0.03, 0.3, 0.03, M.steel, 0, 0.12, 0), box(0.12, 0.03, 0.04, M.steel, 0.04, 0.26, 0), box(0.12, 0.03, 0.04, M.steel, 0.04, 0.02, 0)),

  /* ---- the machine shop ------------------------------------------- */
  /* Measuring tools read as measuring tools because of the ANVIL and the
     dial — a bare stick in the hand looks like every other bare stick. */
  micrometer:() => { const f = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.014, 8, 20, Math.PI * 1.35), M.steel); f.position.y = 0.14; f.rotation.z = -0.6;
                     return grp(f, cyl(0.026, 0.026, 0.14, M.dark, 0.06, 0.2, 0, 14), cyl(0.016, 0.016, 0.05, M.steel, -0.05, 0.16, 0, 12)); },
  dialgauge: () => { const d = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.022, 22), M.white); d.rotation.x = Math.PI / 2; d.position.y = 0.26;
                     return grp(cyl(0.014, 0.014, 0.22, M.steel, 0, 0.08, 0), d, cyl(0.008, 0.008, 0.07, M.steel, 0, -0.04, 0)); },
  torquewrench: () => grp(box(0.034, 0.42, 0.03, M.steel, 0, 0.18, 0), cyl(0.03, 0.03, 0.13, M.handle, 0, -0.04, 0, 14),
                          cyl(0.05, 0.05, 0.035, M.dark, 0, 0.4, 0, 16)),
  boringbar: () => grp(cyl(0.02, 0.02, 0.4, M.steel, 0, 0.18, 0, 14), box(0.05, 0.05, 0.05, M.dark, 0, -0.04, 0), box(0.022, 0.03, 0.022, M.yellow, 0, 0.39, 0)),

  sandblock: () => grp(box(0.16, 0.07, 0.11, M.wood, 0, 0.03, 0), box(0.17, 0.012, 0.12, M.dark, 0, -0.01, 0)),
  paintbrush:() => grp(cyl(0.017, 0.017, 0.24, M.wood, 0, 0.06, 0), box(0.055, 0.05, 0.02, M.steel, 0, 0.19, 0), box(0.06, 0.09, 0.022, M.paint, 0, 0.25, 0)),
  spraycan:  () => grp(cyl(0.05, 0.05, 0.21, M.paint, 0, 0.06, 0, 16), cyl(0.03, 0.03, 0.03, M.white, 0, 0.18, 0)),
  cloth:     () => grp(box(0.17, 0.02, 0.15, M.white, 0, 0.02, 0)),
  magnifier: () => { const r = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.014, 8, 22), M.dark); r.position.y = 0.3; const l = new THREE.Mesh(new THREE.CircleGeometry(0.1, 22), M.glass); l.position.y = 0.3; return grp(cyl(0.02, 0.02, 0.2, M.wood, 0, 0.1, 0), r, l); },
  clipboard: () => grp(box(0.3, 0.4, 0.014, M.kraft, 0, 0.1, 0), box(0.12, 0.05, 0.03, M.steel, 0, 0.29, 0.02), box(0.24, 0.32, 0.004, M.white, 0, 0.07, 0.01)),
  cable:     () => { const g = new THREE.Group(); for (let i = 0; i < 10; i++) g.add(sph(0.022, M.black, Math.sin(i * 0.9) * 0.06, 0.03 * i, Math.cos(i * 0.7) * 0.05)); g.add(box(0.05, 0.06, 0.03, M.steel, 0, 0.32, 0)); return g; },
  panel:     () => grp(box(0.42, 0.42, 0.02, M.kraft, 0, 0.14, 0)),
  plate:     () => grp(box(0.4, 0.34, 0.018, M.steel, 0, 0.12, 0)),
  mug:       () => grp(cyl(0.055, 0.048, 0.12, M.white, 0, 0.05, 0, 16)),

  /* ---- the electronics bench -------------------------------------- */
  /* An iron is a thin hot tip on a fat insulated grip — the silhouette
     has to read at three metres, so the tip is longer than life. */
  iron:      () => grp(cyl(0.026, 0.026, 0.18, M.handle2, 0, 0.04, 0),
                       cyl(0.016, 0.016, 0.07, M.steel, 0, 0.16, 0),
                       cyl(0.008, 0.002, 0.09, M.paint, 0, 0.24, 0)),
  solderreel:() => { const t = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.022, 8, 18), M.steel); t.rotation.y = Math.PI / 2; t.position.y = 0.12; return grp(cyl(0.012, 0.012, 0.3, M.steel, 0, 0.1, 0), t); },
  strippers: () => grp(box(0.024, 0.17, 0.014, M.paint, -0.02, 0.02, 0),
                       box(0.024, 0.17, 0.014, M.paint, 0.02, 0.02, 0),
                       box(0.055, 0.08, 0.018, M.steel, 0, 0.16, 0)),
  multimeter:() => { const g = grp(box(0.17, 0.24, 0.05, M.yellow, 0, 0.08, 0),
                       box(0.12, 0.07, 0.01, M.dark, 0, 0.15, 0.03),
                       cyl(0.035, 0.035, 0.012, M.dark, 0, 0.04, 0.03, 14));
                     for (let i = 0; i < 8; i++) g.add(sph(0.012, M.black, 0.08, 0.3 + 0.03 * i, 0.02 * Math.sin(i)));
                     return g; },
  tweezers:  () => grp(box(0.012, 0.16, 0.008, M.steel, -0.008, 0.06, 0),
                       box(0.012, 0.16, 0.008, M.steel, 0.008, 0.06, 0)),
  breadboard:() => { const g = grp(box(0.34, 0.02, 0.24, M.white, 0, 0.12, 0));
                     for (let i = 0; i < 14; i++) g.add(box(0.006, 0.004, 0.16, M.dark, -0.15 + i * 0.023, 0.132, 0));
                     return g; }
};

export const HEADGEAR = {
  weldmask: () => {
    const g = grp(
      box(0.46, 0.52, 0.06, M.dark, 0, 0.04, 0.24),
      box(0.24, 0.09, 0.02, M.black, 0, 0.12, 0.28),
      box(0.44, 0.1, 0.4, M.dark, 0, 0.3, 0.04)
    );
    g.children[0].rotation.x = -0.14;
    return g;
  },
  goggles: () => grp(box(0.44, 0.14, 0.06, M.dark, 0, 0.08, 0.23), box(0.13, 0.1, 0.02, M.glass, -0.1, 0.08, 0.27), box(0.13, 0.1, 0.02, M.glass, 0.1, 0.08, 0.27), box(0.5, 0.05, 0.44, M.dark, 0, 0.08, 0)),
  hardhat: () => { const d = new THREE.Mesh(new THREE.SphereGeometry(0.31, 16, 10, 0, 7, 0, Math.PI / 2), M.yellow); d.position.y = 0.22; return grp(d, cyl(0.4, 0.4, 0.03, M.yellow, 0, 0.22, 0, 20)); },
  cap: () => { const d = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 10, 0, 7, 0, Math.PI / 2), M.handle); d.position.y = 0.22; return grp(d, box(0.42, 0.03, 0.3, M.handle, 0, 0.22, 0.28)); },
  dustmask: () => grp(box(0.3, 0.17, 0.09, M.white, 0, -0.02, 0.25), box(0.46, 0.03, 0.4, M.white, 0, 0.06, 0.02)),
  /* A bench loupe on a headband — flipped down over one eye, which is
     the only headgear in the shop that is asymmetric, and reads as
     "close work" instantly. */
  loupe: () => grp(box(0.5, 0.06, 0.44, M.dark, 0, 0.2, 0),
                   cyl(0.055, 0.055, 0.07, M.dark, -0.1, 0.09, 0.26, 14),
                   cyl(0.05, 0.05, 0.012, M.glass, -0.1, 0.09, 0.3, 14))
};

export function makeProp(name) {
  const f = PROPS[name];
  if (!f) return null;
  const o = f();
  o.traverse(m => { if (m.isMesh) { m.castShadow = true; } });
  o.name = 'prop:' + name;
  return o;
}
export function makeHeadgear(name) {
  const f = HEADGEAR[name];
  if (!f) return null;
  const o = f();
  o.traverse(m => { if (m.isMesh) m.castShadow = true; });
  o.name = 'gear:' + name;
  return o;
}
