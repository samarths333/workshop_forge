import * as THREE from 'three';
import { cardboardTex, fluteEdgeTex, metalTex, concreteTex, rackTex, galleryTex, signTex, woodTex } from './textures.js';
import { partGeometry, chamferBox, partMaterial as makePartMaterial } from './shapes.js';

export const ROOM_W = 20, ROOM_D = 18, WALL_H = 6.4, PITCH = 22;

export const ROOMS = {
  software:  { key: 'software',  x: -PITCH * 1.5, label: 'SOFTWARE',   sub: 'the spec',    accent: 0x5ec8ff, bench: [-PITCH * 1.5 + 0.4, -4.2] },
  cardboard: { key: 'cardboard', x: -PITCH * 0.5, label: 'CARDBOARD',  sub: 'the mock-up', accent: 0xffa94d, bench: [-PITCH * 0.5, -4.0] },
  finished:  { key: 'finished',  x:  PITCH * 0.5, label: 'FINISHED',   sub: 'the real one',accent: 0xffe9c2, bench: [ PITCH * 0.5, -3.4] },
  metal:     { key: 'metal',     x:  PITCH * 1.5, label: 'METAL',      sub: 'the hard way',accent: 0xff8a3c, bench: [ PITCH * 1.5, -4.0] }
};
export const ROOM_ORDER = ['software', 'cardboard', 'finished', 'metal'];

/* How each action deforms the material in front of Rivet. Anything not listed
   gets 'handle' — the piece is turned over and looked at, not changed. */
export const ACTION_FAMILY = {
  cut_scissors: 'cut', cut_boxcutter: 'cut', saw_metal: 'cut',
  score_fold: 'bend', fold_card: 'bend', bend_metal: 'bend', pliers_bend: 'bend',
  hammer_anvil: 'forge', mallet_form: 'forge',
  grind: 'shave', sand: 'shave', file_metal: 'shave', polish: 'shave',
  paint: 'coat', spray_paint: 'coat',
  drill: 'hole', punch_hole: 'hole',
  weld: 'join', braze: 'join', glue: 'join', tape: 'join',
  rivet: 'join', assemble: 'join', screwdriver: 'join', wrench_tighten: 'join',
  quench: 'cool'
};

/* Top surface of the centre display pedestal in the Finished room — the origin
   the solver places parts against. Must match buildFinished()'s pedestal geometry. */
export const PEDESTAL_TOP = 1.18, PEDESTAL_Z = -4.6;

/* Where a finished part waits after Rivet makes it, until he hauls it to the
   gallery. One rack per working room, just off the end of the bench. */
const STAGE_SPACING = 0.62, STAGE_TOP = 0.92;

/* Raw stock Rivet reaches for when a step shapes material but names no part. */
const STOCK = {
  cardboard: { shape: 'panel', material: 'cardboard', size: [1.1, 0.5, 0.8] },
  metal:     { shape: 'rod',   material: 'metal',     size: [0.5, 1.3, 0.5] },
  finished:  { shape: 'box',   material: 'painted',   size: [0.7, 0.5, 0.5] }
};

const std = (o) => new THREE.MeshStandardMaterial(o);
const box = (w, h, d, m, x = 0, y = 0, z = 0) => {
  const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  o.position.set(x, y, z); o.castShadow = true; o.receiveShadow = true; return o;
};
const cyl = (r1, r2, h, m, x = 0, y = 0, z = 0, s = 16) => {
  const o = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, h, s), m);
  o.position.set(x, y, z); o.castShadow = true; o.receiveShadow = true; return o;
};

export class World {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x08070a);
    this.scene.fog = new THREE.Fog(0x08070a, 34, 92);

    this.camera = new THREE.PerspectiveCamera(46, 16 / 9, 0.1, 400);
    this.camTarget = new THREE.Vector3(ROOMS.cardboard.x, 1.4, 0);
    this.camPos = new THREE.Vector3(ROOMS.cardboard.x, 5.2, 15);
    this.camOrbit = { yaw: 0, pitch: 0.16, dist: 15, free: false };

    this.scene.add(new THREE.HemisphereLight(0x9fb4c8, 0x2a1d12, 0.34));
    const key = new THREE.DirectionalLight(0xfff0dc, 0.55);
    key.position.set(18, 30, 24);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const s = key.shadow.camera;
    s.left = -60; s.right = 60; s.top = 40; s.bottom = -20; s.far = 120;
    this.scene.add(key);

    this.tex = {
      kraft: cardboardTex(3),
      kraftWall: cardboardTex(5, '#b98d58'),
      flute: fluteEdgeTex(6),
      metal: metalTex(3),
      metalWall: metalTex(5, '#5f666f'),
      concrete: concreteTex(8),
      rack: rackTex(),
      gallery: galleryTex(4)
    };

    this.tex.wood = woodTex(2);
    this.buildEnvironment();

    /* everything that ends up on the pedestal lives in here, so clearing a
       job is one removal and the seams stay welded to their parts */
    this.assembly = new THREE.Group();
    this.assembly.position.set(ROOMS.finished.x, PEDESTAL_TOP, PEDESTAL_Z);
    this.scene.add(this.assembly);
    this.workpieces = [];
    this.staged = { cardboard: [], metal: [], finished: [], software: [] };

    this.buildRooms();
    this.buildStagingRacks();
    this.blinkers = [];
    this.clock = new THREE.Clock();
  }

  /* ------------------------------------------------------------- */
  /* a lit room, baked once, purely so metal has something to reflect.
     Without this a "steel bracket" is a flat grey lozenge; with it, it
     reads as steel. Built from plain boxes — no asset to download.     */
  buildEnvironment() {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const s = new THREE.Scene();
    const lit = (c, w, h, d, x, y, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ color: c }));
      m.position.set(x, y, z);
      s.add(m);
      return m;
    };
    // the shell, seen from inside
    const shell = new THREE.Mesh(new THREE.BoxGeometry(22, 12, 22),
      new THREE.MeshBasicMaterial({ color: 0x30302f, side: THREE.BackSide }));
    s.add(shell);
    lit(0x1a1a1c, 22, 0.2, 22, 0, -5.9, 0);          // dark floor
    lit(0xfff2dc, 9, 0.3, 2.2, 0, 5.6, -3);          // main strip overhead
    lit(0xfff2dc, 9, 0.3, 2.2, 0, 5.6, 3);
    lit(0xffb267, 0.4, 4.5, 9, -10.6, 0.5, 0);       // warm wall, forge side
    lit(0x8fc4ff, 0.4, 4.5, 9, 10.6, 0.5, 0);        // cool wall, spec side
    lit(0xf6f1e6, 8, 5, 0.4, 0, 0.5, -10.6);         // gallery bounce card

    const rt = pmrem.fromScene(s, 0.03);
    this.scene.environment = rt.texture;
    this.envMap = rt.texture;
    s.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    pmrem.dispose();
  }

  /* ------------------------------------------------------------- */
  hangSign(room, text, sub, x, y, z, rot = 0) {
    const g = new THREE.Group();
    const m = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.3, 0.09),
      [new THREE.MeshStandardMaterial({ map: this.tex.flute, roughness: 1 }),
       new THREE.MeshStandardMaterial({ map: this.tex.flute, roughness: 1 }),
       new THREE.MeshStandardMaterial({ map: this.tex.flute, roughness: 1 }),
       new THREE.MeshStandardMaterial({ map: this.tex.flute, roughness: 1 }),
       new THREE.MeshStandardMaterial({ map: signTex(text, sub), roughness: 0.95 }),
       new THREE.MeshStandardMaterial({ map: this.tex.kraft, roughness: 1 })]);
    m.castShadow = true;
    g.add(m);
    const lineMat = new THREE.LineBasicMaterial({ color: 0xd8cfc0, transparent: true, opacity: 0.5 });
    for (const sx of [-1.05, 1.05]) {
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(sx, 0.62, 0), new THREE.Vector3(sx * 0.7, WALL_H - y, 0)
      ]);
      g.add(new THREE.Line(geo, lineMat));
    }
    g.position.set(x, y, z);
    g.rotation.z = rot;
    g.userData.sway = Math.random() * 6;
    this.scene.add(g);
    (this.signs = this.signs || []).push(g);
    return g;
  }

  shell(room, floorMat, wallMat, ceilTone) {
    const g = new THREE.Group();
    const cx = room.x;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_W, ROOM_D), floorMat);
    floor.rotation.x = -Math.PI / 2; floor.position.set(cx, 0, 0); floor.receiveShadow = true;
    g.add(floor);

    // back wall
    g.add(box(ROOM_W, WALL_H, 0.4, wallMat, cx, WALL_H / 2, -ROOM_D / 2));
    // side walls with a doorway gap
    for (const sx of [-1, 1]) {
      const wx = cx + sx * ROOM_W / 2;
      g.add(box(0.4, WALL_H, 5.6, wallMat, wx, WALL_H / 2, -ROOM_D / 2 + 2.8));
      g.add(box(0.4, WALL_H, 5.6, wallMat, wx, WALL_H / 2, ROOM_D / 2 - 2.8));
      g.add(box(0.4, 1.9, 6.8, wallMat, wx, WALL_H - 0.95, 0));
    }
    // ceiling + slats (the "looking into a box" framing)
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_W, ROOM_D),
      std({ color: ceilTone, roughness: 1, side: THREE.DoubleSide }));
    ceil.rotation.x = Math.PI / 2; ceil.position.set(cx, WALL_H, 0);
    g.add(ceil);
    const slat = std({ color: ceilTone, roughness: 1 });
    for (let z = -7; z <= 7; z += 3.5) g.add(box(ROOM_W, 0.22, 0.3, slat, cx, WALL_H - 0.14, z));

    this.scene.add(g);
    return g;
  }

  roomLight(room, color, intensity, y = 4.6) {
    const l = new THREE.PointLight(color, intensity, 26, 1.9);
    l.position.set(room.x, y, 0);
    l.castShadow = true;
    l.shadow.mapSize.set(1024, 1024);
    this.scene.add(l);
    return l;
  }

  /* ------------------------------------------------------------- */
  buildRooms() {
    this.buildSoftware();
    this.buildCardboard();
    this.buildFinished();
    this.buildMetal();
  }

  buildSoftware() {
    const R = ROOMS.software, cx = R.x;
    const wall = std({ color: 0x1b1f26, roughness: 0.9 });
    this.shell(R, std({ map: this.tex.concrete, roughness: 0.75, metalness: 0.05 }), wall, 0x14171c);
    this.roomLight(R, 0x8fc7ff, 26, 5.2);
    const rim = new THREE.PointLight(0x3d7ffb, 22, 22, 2);
    rim.position.set(cx - 5, 2.4, -6); this.scene.add(rim);

    const rackMat = std({ map: this.tex.rack, roughness: 0.55, metalness: 0.35, emissive: 0x0d2233, emissiveIntensity: 0.5 });
    const frame = std({ color: 0x0f1216, roughness: 0.6, metalness: 0.5 });
    // cold aisle of racks
    for (let i = 0; i < 5; i++) {
      const x = cx - 7.2 + i * 2.2;
      const r = new THREE.Group();
      r.add(box(1.7, 4.4, 1.4, frame, 0, 2.2, 0));
      const face = box(1.5, 4.1, 0.06, rackMat, 0, 2.2, 0.72);
      r.add(face);
      r.position.set(x, 0, -7);
      this.scene.add(r);
      this.blinkers = this.blinkers || [];
    }
    for (let i = 0; i < 3; i++) {
      const r = new THREE.Group();
      r.add(box(1.4, 4.2, 1.7, frame, 0, 2.1, 0));
      const face = box(0.06, 4.0, 1.5, rackMat, 0.72, 2.1, 0);
      face.rotation.y = Math.PI / 2;
      r.add(face);
      r.position.set(cx - 8.6, 0, -3 + i * 2.4);
      this.scene.add(r);
    }
    // floor LED strip
    const strip = box(13, 0.03, 0.16, std({ color: 0x1b8cff, emissive: 0x1b8cff, emissiveIntensity: 3 }), cx - 1, 0.02, -5.2);
    this.scene.add(strip);

    // the old beige desktop, off to the side
    const beige = std({ color: 0xd8cfb4, roughness: 0.85 });
    const dark = std({ color: 0x24262a, roughness: 0.7 });
    const desk = new THREE.Group();
    desk.add(box(3.2, 0.12, 1.6, std({ map: this.tex.metal, roughness: 0.6, metalness: 0.4 }), 0, 1.02, 0));
    for (const [dx, dz] of [[-1.4, -0.6], [1.4, -0.6], [-1.4, 0.6], [1.4, 0.6]])
      desk.add(cyl(0.05, 0.05, 1.0, dark, dx, 0.5, dz, 8));
    desk.add(box(1.3, 1.1, 1.2, beige, -0.55, 1.63, -0.1));                       // CRT body
    const scr = box(1.02, 0.8, 0.06, std({ color: 0x0a1a12, emissive: 0x1fbf6b, emissiveIntensity: 0.9 }), -0.55, 1.68, 0.52);
    desk.add(scr);
    this.crt = scr;
    desk.add(box(0.9, 0.6, 1.3, beige, 0.95, 1.32, -0.1));                         // tower
    desk.add(box(0.5, 0.05, 0.02, std({ color: 0x9aa0a6 }), 0.95, 1.42, 0.56));
    desk.add(box(0.09, 0.09, 0.02, std({ color: 0x4ade80, emissive: 0x4ade80, emissiveIntensity: 2 }), 0.7, 1.16, 0.56));
    desk.add(box(1.15, 0.06, 0.44, beige, 0.1, 1.11, 0.5));                        // keyboard
    desk.add(box(0.2, 0.05, 0.3, beige, 0.95, 1.11, 0.5));                         // mouse
    const chair = new THREE.Group();
    chair.add(box(0.7, 0.1, 0.7, dark, 0, 0.6, 0));
    chair.add(box(0.7, 0.9, 0.1, dark, 0, 1.05, -0.3));
    chair.add(cyl(0.07, 0.07, 0.6, dark, 0, 0.3, 0, 8));
    chair.position.set(0.1, 0, 1.5);
    desk.add(chair);
    desk.position.set(cx + 4.6, 0, -4.6);
    desk.rotation.y = -0.5;
    this.scene.add(desk);
    R.seat = [cx + 4.4, -3.2];

    this.hangSign(ROOMS.software, 'SOFTWARE', 'the spec', cx + 0.5, 4.7, 4.2, -0.03);
    this.hangSign(ROOMS.software, 'v2', '', cx - 7.4, 5.0, 4.6, 0.05);
  }

  buildCardboard() {
    const R = ROOMS.cardboard, cx = R.x;
    const wall = std({ map: this.tex.kraftWall, roughness: 1, color: 0x8a5f38 });
    this.shell(R, std({ map: this.tex.kraft, roughness: 1 }), wall, 0x5a3b21);
    this.roomLight(R, 0xffc47a, 34, 5.0);
    const warm = new THREE.PointLight(0xff9a4d, 16, 20, 2);
    warm.position.set(cx + 5, 2.2, 2); this.scene.add(warm);

    const kraft = std({ map: this.tex.kraft, roughness: 1 });
    const flute = std({ map: this.tex.flute, roughness: 1 });

    // workbench
    const bench = new THREE.Group();
    bench.add(box(5.2, 0.22, 2.2, flute, 0, 1.0, 0));
    for (const [dx, dz] of [[-2.3, -0.85], [2.3, -0.85], [-2.3, 0.85], [2.3, 0.85]])
      bench.add(box(0.24, 1.0, 0.24, kraft, dx, 0.5, dz));
    bench.add(box(5.0, 0.1, 1.9, kraft, 0, 0.45, 0));
    bench.position.set(cx, 0, -5.6);
    this.scene.add(bench);

    // stacked sheet blanks
    for (let i = 0; i < 7; i++)
      this.scene.add(box(3.0, 0.07, 2.1, i % 2 ? kraft : flute, cx - 6.4, 0.06 + i * 0.075, -3 + Math.random() * 0.2));
    // tubes
    for (let i = 0; i < 4; i++) {
      const t = cyl(0.42, 0.42, 3.6, flute, cx + 7.2, 0.44 + i * 0.9, -5.4 + (i % 2) * 0.9, 18);
      t.rotation.z = Math.PI / 2; this.scene.add(t);
    }
    // the big cut ring + roller, straight out of the reference frame
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 1.9, 1.0, 40, 1, true), flute);
    const ringOut = new THREE.Mesh(new THREE.TorusGeometry(1.9, 0.03, 6, 40), kraft);
    const disc = new THREE.Mesh(new THREE.RingGeometry(0.85, 1.9, 40), new THREE.MeshStandardMaterial({ map: this.tex.kraft, roughness: 1, side: THREE.DoubleSide }));
    disc.rotation.y = Math.PI / 2; disc.position.x = 0.5;
    ring.rotation.z = Math.PI / 2; ring.castShadow = true;
    const wheel = new THREE.Group(); wheel.add(ring, disc);
    wheel.position.set(cx - 3.4, 1.92, 2.6); wheel.rotation.z = 0.06;
    this.scene.add(wheel);
    this.cardWheel = wheel;

    const roller = cyl(1.2, 1.2, 3.0, flute, cx + 0.6, 1.25, 2.6, 22);
    roller.rotation.z = Math.PI / 2; this.scene.add(roller);
    this.scene.add(box(1.7, 1.9, 1.7, flute, cx + 2.7, 1.25, 2.6));

    this.hangSign(R, 'CARDBOARD', 'v2', cx - 5.6, 4.8, 4.0, -0.04);
    this.hangSign(R, 'CUT', 'then fold', cx + 3.4, 5.1, 4.6, 0.05);
    this.hangSign(R, 'MOCK IT', 'first', cx + 7.8, 4.5, 1.6, -0.06);
  }

  buildFinished() {
    const R = ROOMS.finished, cx = R.x;
    const wall = std({ map: this.tex.gallery, roughness: 0.92 });
    this.shell(R, std({ color: 0x2b2724, roughness: 0.5, metalness: 0.1 }), wall, 0xe6e0d4);
    this.roomLight(R, 0xfff4e2, 26, 5.4);

    // three pedestals under spots
    const ped = std({ color: 0xf2ece1, roughness: 0.7 });
    this.pedestals = [];
    for (let i = 0; i < 3; i++) {
      const x = cx - 4.2 + i * 4.2;
      const p = new THREE.Group();
      p.add(box(1.7, 1.1, 1.7, ped, 0, 0.55, 0));
      p.add(box(1.9, 0.08, 1.9, std({ color: 0xd9d2c6, roughness: 0.6 }), 0, 1.14, 0));
      p.position.set(x, 0, -4.6);
      this.scene.add(p);
      const spot = new THREE.SpotLight(0xfff2dd, 60, 14, 0.42, 0.55, 1.6);
      spot.position.set(x, WALL_H - 0.4, -4.0);
      spot.target.position.set(x, 1.2, -4.6);
      spot.castShadow = true;
      this.scene.add(spot, spot.target);
      this.pedestals.push({ group: p, x, z: -4.6, spot });
    }
    // shelving of past builds
    const shelfMat = std({ color: 0xe8e2d6, roughness: 0.75 });
    for (let i = 0; i < 3; i++)
      this.scene.add(box(6.0, 0.14, 1.1, shelfMat, cx + 6.6, 1.4 + i * 1.5, -6.2));
    const junk = [0xc69a63, 0x8d949e, 0x3fa9c9, 0xd6453c, 0xf2c14e];
    for (let i = 0; i < 12; i++) {
      const c = junk[i % junk.length];
      const h = 0.4 + Math.random() * 0.6;
      this.scene.add(box(0.4 + Math.random() * 0.5, h, 0.4, std({ color: c, roughness: 0.7 }),
        cx + 4.2 + Math.random() * 4.6, 1.47 + Math.floor(i / 4) * 1.5 + h / 2, -6.2));
    }
    R.assemblyPoint = [cx, -1.2];
    this.hangSign(R, 'FINISHED', 'the real one', cx, 4.9, 4.2, 0.02);
  }

  buildMetal() {
    const R = ROOMS.metal, cx = R.x;
    const wall = std({ map: this.tex.metalWall, roughness: 0.65, metalness: 0.4 });
    this.shell(R, std({ map: this.tex.concrete, roughness: 0.85 }), wall, 0x2a2e33);
    this.roomLight(R, 0xffd6a0, 26, 5.2);
    const ember = new THREE.PointLight(0xff7a2a, 14, 18, 2);
    ember.position.set(cx - 4, 1.6, -3); this.scene.add(ember);

    const steel = std({ map: this.tex.metal, roughness: 0.45, metalness: 0.7 });
    const dark = std({ color: 0x33383f, roughness: 0.6, metalness: 0.5 });
    const wood = std({ color: 0x7d5636, roughness: 0.95 });

    // welding bench
    const b = new THREE.Group();
    b.add(box(5.0, 0.24, 2.2, steel, 0, 1.0, 0));
    for (const [dx, dz] of [[-2.2, -0.85], [2.2, -0.85], [-2.2, 0.85], [2.2, 0.85]])
      b.add(box(0.18, 1.0, 0.18, dark, dx, 0.5, dz));
    b.add(box(4.6, 0.1, 1.8, dark, 0, 0.42, 0));
    b.position.set(cx, 0, -5.4);
    this.scene.add(b);

    // vise, bolted on
    const vise = new THREE.Group();
    vise.add(box(0.7, 0.3, 0.5, steel, 0, 0.15, 0));
    vise.add(box(0.24, 0.42, 0.56, dark, -0.24, 0.4, 0));
    vise.add(box(0.24, 0.42, 0.56, dark, 0.22, 0.4, 0));
    vise.add(cyl(0.05, 0.05, 0.8, steel, 0.55, 0.4, 0, 10));
    vise.children[3].rotation.z = Math.PI / 2;
    vise.position.set(cx + 1.8, 1.12, -5.2);
    this.scene.add(vise);

    // anvil on a stump
    const anvil = new THREE.Group();
    anvil.add(cyl(0.55, 0.62, 1.0, wood, 0, 0.5, 0, 14));
    anvil.add(box(1.5, 0.3, 0.62, dark, 0, 1.15, 0));
    anvil.add(box(0.8, 0.22, 0.46, dark, -0.1, 0.94, 0));
    const horn = cyl(0.22, 0.03, 0.7, dark, 0.98, 1.15, 0, 12);
    horn.rotation.z = -Math.PI / 2; anvil.add(horn);
    anvil.position.set(cx - 4.6, 0, -2.4);
    this.scene.add(anvil);

    // pipe rack
    for (let i = 0; i < 6; i++) {
      const p = cyl(0.13, 0.13, 6.5, steel, cx + 7.4, 0.5 + Math.floor(i / 3) * 0.34, -4 + (i % 3) * 0.34, 10);
      p.rotation.x = Math.PI / 2; this.scene.add(p);
    }
    // rolling toolbox, cartoon red
    const tb = new THREE.Group();
    const red = std({ color: 0xd6453c, roughness: 0.55, metalness: 0.3 });
    tb.add(box(1.9, 1.5, 0.9, red, 0, 0.85, 0));
    for (let i = 0; i < 4; i++) {
      tb.add(box(1.75, 0.28, 0.06, std({ color: 0xb03a32, roughness: 0.6 }), 0, 0.35 + i * 0.36, 0.47));
      tb.add(box(0.7, 0.06, 0.06, std({ color: 0xd8dde3, metalness: 0.8, roughness: 0.3 }), 0, 0.35 + i * 0.36, 0.53));
    }
    for (const dx of [-0.7, 0.7]) { const w = cyl(0.16, 0.16, 0.12, dark, dx, 0.12, 0, 12); w.rotation.z = Math.PI / 2; tb.add(w); }
    tb.position.set(cx + 4.6, 0, -1.4);
    this.scene.add(tb);

    // bench grinder on a pedestal
    const gp = new THREE.Group();
    gp.add(cyl(0.24, 0.3, 1.1, dark, 0, 0.55, 0, 10));
    gp.add(box(0.8, 0.34, 0.5, steel, 0, 1.25, 0));
    const gw = cyl(0.34, 0.34, 0.1, std({ color: 0x6d6a63, roughness: 0.95 }), 0.5, 1.3, 0, 18);
    gw.rotation.z = Math.PI / 2; gp.add(gw);
    gp.position.set(cx - 7.4, 0, -4.4);
    this.scene.add(gp);
    this.grindWheel = gw;

    // hanging shop lamp
    const lampG = new THREE.Group();
    const shade = new THREE.Mesh(new THREE.ConeGeometry(0.8, 0.7, 18, 1, true), std({ color: 0x2f343b, side: THREE.DoubleSide, roughness: 0.7 }));
    shade.position.y = 0; lampG.add(shade);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), std({ color: 0xfff0c0, emissive: 0xffe0a0, emissiveIntensity: 3 }));
    bulb.position.y = -0.3; lampG.add(bulb);
    lampG.position.set(cx, 4.4, -4.0);
    this.scene.add(lampG);
    this.shopLamp = lampG;
    const lampLight = new THREE.PointLight(0xffd9a0, 24, 13, 2);
    lampLight.position.set(cx, 4.0, -4.0); this.scene.add(lampLight);

    this.hangSign(R, 'METAL', 'the hard way', cx - 1.2, 5.0, 4.2, -0.03);
    this.hangSign(R, 'HOT', 'do not touch', cx + 6.2, 4.6, 2.0, 0.06);
  }

  /* ------------------------------------------------------------- */
  /* parts                                                          */
  /* ------------------------------------------------------------- */
  /* Real stock, not tinted lozenges. Every one of these is a physical
     material lit by the baked room environment, which is what makes a
     welded bracket read as steel and a painted panel read as paint.
     Defined in shapes.js so the CAD workspace shows the same materials
     the shop does. */
  partMaterial(kind, color) { return makePartMaterial(kind, color, this.tex); }

  /* Geometry generation lives in shapes.js so it can be checked against
     the solver's idea of size without a renderer. These two forward on so
     the rest of the file reads the same as it always did. */
  chamferBox(w, h, d) { return chamferBox(w, h, d); }
  partGeometry(shape, s) { return partGeometry(shape, s); }

  /* One finished component, ready to be carried. */
  makePart(spec, size) {
    const m = new THREE.Mesh(this.partGeometry(spec.shape, size), this.partMaterial(spec.material, spec.color));
    m.castShadow = m.receiveShadow = true;
    m.userData.spec = spec;
    m.userData.size = size;
    return m;
  }

  /* ------------------------------------------------------------- */
  /* workpiece — real material on the bench that Rivet works on      */
  /* ------------------------------------------------------------- */

  /* Put stock on the bench in front of Rivet at the START of a step, so the
     tool always meets material instead of empty air. Returns a handle that
     updateWork() deforms and releaseWork() hands off to the gallery. */
  beginWork(step, roomKey) {
    if (roomKey === 'software') return null;                 // spec room, no material
    const family = ACTION_FAMILY[step.action] || 'handle';
    const spec = step.part || STOCK[roomKey] || STOCK.cardboard;
    const size = (spec.size && spec.size.length === 3 ? spec.size : [0.7, 0.5, 0.5])
      .map(v => Math.max(0.08, Math.min(3.2, Number(v) || 0.4)));

    const mat = this.partMaterial(spec.material || (roomKey === 'metal' ? 'metal' : 'cardboard'), spec.color);

    const r = ROOMS[roomKey] || ROOMS.cardboard;
    const g = new THREE.Group();
    g.position.set(r.bench[0], 1.25, r.bench[1] + 0.35);
    this.scene.add(g);

    const wp = { group: g, family, spec, size, mat, roomKey, baseColor: mat.color.clone(), contact: new THREE.Vector3() };

    const geo = this.partGeometry(spec.shape, size);
    const main = new THREE.Mesh(geo, mat);
    main.castShadow = main.receiveShadow = true;

    if (family === 'join') {
      // two halves that converge into one piece as he welds/glues/bolts
      main.position.set(-size[0] * 0.55, size[1] / 2, 0);
      const other = new THREE.Mesh(geo.clone(), mat);
      other.castShadow = other.receiveShadow = true;
      other.position.set(size[0] * 0.55, size[1] / 2, 0);
      g.add(main, other);
      wp.mate = other;
    } else if (family === 'bend') {
      // hinged pair — the far half folds up around the crease
      const half = this.partGeometry(spec.shape, [size[0] / 2, size[1], size[2]]);
      main.geometry = half;
      main.position.set(-size[0] / 4, size[1] / 2, 0);
      const hinge = new THREE.Group();
      hinge.position.set(0, size[1] / 2, 0);
      const flap = new THREE.Mesh(half.clone(), mat);
      flap.castShadow = flap.receiveShadow = true;
      flap.position.set(size[0] / 4, 0, 0);
      hinge.add(flap);
      g.add(main, hinge);
      wp.hinge = hinge;
    } else if (family === 'cut') {
      // a slice that separates and drops off the bench
      main.position.set(0, size[1] / 2, 0);
      const off = new THREE.Mesh(this.partGeometry(spec.shape, [size[0] * 0.34, size[1], size[2]]), mat);
      off.castShadow = true;
      off.position.set(size[0] * 0.62, size[1] / 2, 0);
      g.add(main, off);
      wp.offcut = off;
    } else {
      main.position.set(0, size[1] / 2, 0);
      g.add(main);
      if (family === 'hole') {
        const bit = new THREE.Mesh(
          new THREE.CylinderGeometry(size[0] * 0.09, size[0] * 0.09, size[1] * 1.3, 12),
          std({ color: 0x121013, roughness: 1 })
        );
        bit.position.set(0, size[1] * 1.4, 0);
        g.add(bit);
        wp.bore = bit;
      }
    }

    wp.main = main;
    this.workpieces = this.workpieces || [];
    this.workpieces.push(wp);
    this.workContact(wp);
    return wp;
  }

  /* The spot on the material the tool is supposed to be touching — the top
     face, on the near side, where a person would actually be working. Rivet
     aims his right hand at this every frame, which is what turns a canned
     arm animation into him working the piece. */
  workContact(wp) {
    if (!wp) return null;
    const target = wp.offcut || wp.mate || wp.main;
    target.getWorldPosition(wp.contact);
    wp.contact.y = wp.group.position.y + Math.max(0.08, wp.size[1] * 0.9);
    wp.contact.z += Math.min(0.28, wp.size[2] * 0.4);
    return wp.contact;
  }

  /* Drive the deformation. k is 0→1 across the step; t is wall time for jitter. */
  updateWork(wp, k, t) {
    if (!wp) return;
    const s = wp.size, m = wp.main;
    switch (wp.family) {
      case 'cut': {
        // blade bites in, then the offcut breaks free and tumbles to the floor
        const bite = Math.min(1, k / 0.62);
        m.scale.x = 1 - bite * 0.3;
        m.position.x = -s[0] * 0.15 * bite;
        if (k > 0.62 && wp.offcut) {
          const f = (k - 0.62) / 0.38;
          wp.offcut.position.x = s[0] * (0.62 + f * 0.5);
          wp.offcut.position.y = s[1] / 2 - f * f * 1.5;
          wp.offcut.rotation.z -= 0.09;
        } else if (wp.offcut) {
          wp.offcut.position.x = s[0] * 0.62 + Math.sin(t * 22) * 0.006;
        }
        break;
      }
      case 'bend': {
        // creases progressively, with the material springing back a little
        const a = k * Math.PI * 0.46;
        if (wp.hinge) wp.hinge.rotation.z = -a + Math.sin(t * 18) * 0.02 * (1 - k);
        break;
      }
      case 'forge': {
        // squashes down a notch on every hammer blow
        const blows = Math.floor(k * 6);
        const sq = 1 - blows * 0.055;
        m.scale.set(1 + blows * 0.045, sq, 1 + blows * 0.03);
        m.position.y = (s[1] * sq) / 2;
        m.rotation.y = blows * 0.12;
        break;
      }
      case 'shave': {
        m.scale.setScalar(1 - k * 0.1);
        m.rotation.y = k * 1.4;
        m.position.y = (s[1] * (1 - k * 0.1)) / 2;
        wp.mat.roughness = Math.max(0.08, (wp.mat.roughness ?? 0.5) - k * 0.004);
        break;
      }
      case 'coat': {
        // colour sweeps across as the coat goes on
        const target = wp.spec.color ? new THREE.Color(wp.spec.color) : new THREE.Color(0x3fa9c9);
        wp.mat.color.copy(wp.baseColor).lerp(target, k);
        wp.mat.map = k > 0.5 ? null : wp.mat.map;
        wp.mat.needsUpdate = true;
        m.rotation.y = k * 1.1;
        break;
      }
      case 'hole': {
        if (wp.bore) {
          const d = Math.min(1, k / 0.8);
          wp.bore.position.y = s[1] * (1.4 - d * 1.0) + Math.sin(t * 40) * 0.012;
        }
        m.rotation.y = Math.sin(t * 3) * 0.05;
        break;
      }
      case 'join': {
        // the two halves close up and fuse
        const c = Math.min(1, k / 0.75);
        m.position.x = -s[0] * 0.55 * (1 - c);
        if (wp.mate) {
          wp.mate.position.x = s[0] * 0.55 * (1 - c);
          if (c >= 1) wp.mate.visible = false;      // fused — one piece now
        }
        if (c >= 1) m.scale.x = 1.06;
        break;
      }
      case 'cool': {
        // glowing hot, then quenched back to cold metal
        wp.mat.emissive.setHex(0xff5a1a);
        wp.mat.emissiveIntensity = Math.max(0, 1.6 * (1 - k));
        wp.mat.needsUpdate = true;
        break;
      }
      default:
        m.rotation.y = k * Math.PI * 0.5;           // turned over and checked
        m.position.y = s[1] / 2 + Math.sin(k * Math.PI) * 0.12;
    }
    this.workContact(wp);
  }

  /* Step finished. If it made a part, bake the workpiece into a single mesh
     and hand it back; otherwise the stock goes back in the bin. */
  releaseWork(wp, keep) {
    if (!wp) return null;
    const idx = (this.workpieces || []).indexOf(wp);
    if (idx >= 0) this.workpieces.splice(idx, 1);
    if (!keep) { this.scene.remove(wp.group); return null; }

    const m = new THREE.Mesh(this.partGeometry(wp.spec.shape, wp.size), wp.mat);
    m.castShadow = m.receiveShadow = true;
    wp.group.getWorldPosition(m.position);
    m.position.y += wp.size[1] / 2;
    m.userData.spec = wp.spec;
    m.userData.size = wp.size;
    this.scene.remove(wp.group);
    this.scene.add(m);
    return m;
  }

  clearWork() {
    for (const wp of this.workpieces || []) this.scene.remove(wp.group);
    this.workpieces = [];
  }

  /* ------------------------------------------------------------- */
  /* staging — where a finished part waits to be carried            */
  /* ------------------------------------------------------------- */
  buildStagingRacks() {
    const frame = std({ color: 0x4a4640, roughness: 0.6, metalness: 0.4 });
    const board = std({ map: this.tex.wood, roughness: 0.8 });
    this.racks = {};
    const spots = {
      cardboard: [ROOMS.cardboard.x - 3.2, -3.0],
      metal:     [ROOMS.metal.x - 2.2, -1.7],
      finished:  [ROOMS.finished.x - 5.4, -1.2]
    };
    for (const [key, [x, z]] of Object.entries(spots)) {
      const g = new THREE.Group();
      g.add(box(2.8, 0.1, 0.9, board, 0, STAGE_TOP, 0));
      for (const dx of [-1.2, 1.2]) {
        g.add(box(0.1, STAGE_TOP, 0.1, frame, dx, STAGE_TOP / 2, -0.34));
        g.add(box(0.1, STAGE_TOP, 0.1, frame, dx, STAGE_TOP / 2, 0.34));
        g.add(box(0.1, 0.08, 0.82, frame, dx, STAGE_TOP * 0.35, 0));
      }
      g.position.set(x, 0, z);
      this.scene.add(g);
      this.racks[key] = { x, z, group: g };
    }
    this.stageTweens = [];
  }

  /* Where the nth part in a room's rack sits, in world space. */
  stageSlot(roomKey, i, size) {
    const r = this.racks?.[roomKey] || this.racks?.cardboard;
    const row = Math.floor(i / 5);
    const col = i % 5;
    return new THREE.Vector3(
      r.x - 1.24 + col * STAGE_SPACING,
      STAGE_TOP + 0.05 + (size ? size[1] / 2 : 0.2),
      r.z + (row ? 0.3 : -0.1)
    );
  }

  /* Set a finished part aside on the rack. He does not fling it across the
     shop — it slides to the end of the bench and waits for the haul. */
  stagePart(mesh, roomKey) {
    const key = this.racks?.[roomKey] ? roomKey : 'cardboard';
    const list = this.staged[key] || (this.staged[key] = []);
    const slot = this.stageSlot(key, list.length, mesh.userData.size);
    list.push(mesh);
    mesh.userData.room = key;
    this.stageTweens.push({ mesh, from: mesh.position.clone(), to: slot, t: 0, dur: 0.55 });
    return slot;
  }

  /* Everything waiting to be hauled, nearest room to Rivet first. */
  stagedRooms() {
    return Object.entries(this.staged)
      .filter(([, list]) => list.length)
      .map(([room, list]) => ({ room, count: list.length, x: this.racks?.[room]?.x ?? ROOMS[room].x }));
  }

  takeStaged(roomKey, n) {
    const list = this.staged[roomKey] || [];
    return list.splice(0, Math.max(1, n));
  }

  /* ------------------------------------------------------------- */
  /* final placement on the pedestal                                */
  /* ------------------------------------------------------------- */
  /* The solver already worked out where this belongs. The assembly group
     sits on the pedestal top, so an instance position drops straight in. */
  placeInstance(mesh, inst, fromWorld) {
    const start = (fromWorld ? fromWorld.clone() : mesh.getWorldPosition(new THREE.Vector3()));
    if (mesh.parent) mesh.parent.remove(mesh);
    this.assembly.add(mesh);
    mesh.rotation.set(inst.rot[0], inst.rot[1], inst.rot[2]);
    const s = inst.scale || 1;
    mesh.scale.set(s, s, s);
    mesh.userData.instance = inst;
    mesh.castShadow = mesh.receiveShadow = true;

    // it travels the last half-metre out of his hands rather than appearing
    const to = new THREE.Vector3(inst.pos[0], inst.pos[1], inst.pos[2]);
    const from = this.assembly.worldToLocal(start);
    mesh.position.copy(from);
    this.stageTweens.push({ mesh, from: from.clone(), to, t: 0, dur: 0.45 });
    return mesh;
  }

  /* A copy of a part, for the instances of an array that Rivet did not
     personally carry over (he carries one, the rest are the same batch). */
  cloneForInstance(mesh) {
    const c = new THREE.Mesh(mesh.geometry, mesh.material);
    c.castShadow = c.receiveShadow = true;
    c.userData.spec = mesh.userData.spec;
    c.userData.size = mesh.userData.size;
    return c;
  }

  /* ------------------------------------------------------------- */
  /* seams — what makes it one object instead of a stack            */
  /* ------------------------------------------------------------- */
  buildSeams(joints) {
    if (!joints || !joints.length) return 0;
    const beadGeo = new THREE.SphereGeometry(0.028, 8, 6);
    const beadMat = std({ color: 0xb4bac4, roughness: 0.5, metalness: 0.85, envMapIntensity: 1.1 });
    const boltGeo = new THREE.CylinderGeometry(0.035, 0.035, 0.05, 6);
    const boltMat = std({ color: 0x9aa2ad, roughness: 0.32, metalness: 0.9, envMapIntensity: 1.2 });
    const glueMat = new THREE.MeshPhysicalMaterial({
      color: 0xe4bd7c, roughness: 0.3, metalness: 0, transmission: 0.45,
      thickness: 0.04, transparent: true, opacity: 0.85
    });

    const g = new THREE.Group();
    let made = 0;
    for (const j of joints.slice(0, 26)) {
      const longAxis = j.wu >= j.wv ? j.u : j.v;
      const len = Math.max(j.wu, j.wv) * 0.88;
      const other = j.wu >= j.wv ? j.v : j.u;

      if (j.kind === 'weld') {
        const n = Math.max(3, Math.min(20, Math.round(len / 0.062)));
        for (let i = 0; i < n; i++) {
          const b = new THREE.Mesh(beadGeo, beadMat);
          const p = [j.pos[0], j.pos[1], j.pos[2]];
          p[longAxis] += (i / (n - 1) - 0.5) * len;
          p[j.axis] += (Math.random() - 0.5) * 0.006;
          p[other] += (Math.random() - 0.5) * 0.012;
          b.position.set(p[0], p[1], p[2]);
          b.scale.set(1, 0.72 + Math.random() * 0.5, 1);
          b.castShadow = true;
          g.add(b);
        }
        made++;
      } else if (j.kind === 'bolt') {
        const n = len > 0.85 ? 3 : 2;
        for (let i = 0; i < n; i++) {
          const b = new THREE.Mesh(boltGeo, boltMat);
          const p = [j.pos[0], j.pos[1], j.pos[2]];
          p[longAxis] += (n === 1 ? 0 : (i / (n - 1) - 0.5)) * len * 0.7;
          b.position.set(p[0], p[1], p[2]);
          if (j.axis === 0) b.rotation.z = Math.PI / 2;
          if (j.axis === 2) b.rotation.x = Math.PI / 2;
          b.castShadow = true;
          g.add(b);
        }
        made++;
      } else {
        const dims = [0, 0, 0];
        dims[j.axis] = 0.03;
        dims[longAxis] = len;
        dims[other] = Math.min(j.wu, j.wv) * 0.85;
        const f = new THREE.Mesh(new THREE.BoxGeometry(
          Math.max(0.02, dims[0]), Math.max(0.02, dims[1]), Math.max(0.02, dims[2])), glueMat);
        f.position.set(j.pos[0], j.pos[1], j.pos[2]);
        g.add(f);
        made++;
      }
    }
    this.assembly.add(g);
    this.seams = g;
    return made;
  }

  /* Re-place the whole assembly from a freshly solved layout. This is what
     the CAD bench calls after an edit: instant, no tweens and no walking,
     because this is not Rivet doing the work — it is the drawing being
     corrected under him. */
  rebuildAssembly(solved) {
    this.stageTweens = (this.stageTweens || []).filter(t => t.mesh.parent !== this.assembly);
    for (let i = this.assembly.children.length - 1; i >= 0; i--) {
      this.assembly.remove(this.assembly.children[i]);
    }
    for (const inst of solved.instances) {
      const mesh = new THREE.Mesh(
        this.partGeometry(inst.shape, inst.size),
        this.partMaterial(inst.material, inst.color)
      );
      mesh.castShadow = mesh.receiveShadow = true;
      const s = inst.scale || 1;
      mesh.scale.set(s, s, s);
      mesh.rotation.set(inst.rot[0], inst.rot[1], inst.rot[2]);
      mesh.position.set(inst.pos[0], inst.pos[1], inst.pos[2]);
      mesh.userData.instance = inst;
      mesh.userData.spec = { name: inst.name, shape: inst.shape, material: inst.material };
      this.assembly.add(mesh);
    }
    this.buildSeams(solved.joints);
    return solved.instances.length;
  }

  clearAssembly() {
    for (let i = this.assembly.children.length - 1; i >= 0; i--) {
      this.assembly.remove(this.assembly.children[i]);
    }
    for (const list of Object.values(this.staged)) {
      for (const m of list) this.scene.remove(m);
      list.length = 0;
    }
    for (let i = this.scene.children.length - 1; i >= 0; i--) {
      const c = this.scene.children[i];
      if (c.userData && c.userData.spec) this.scene.remove(c);
    }
    this.stageTweens = [];
    this.seams = null;
    this.clearWork();
  }

  /* ------------------------------------------------------------- */
  /* camera + frame                                                 */
  /* ------------------------------------------------------------- */
  lookAtRoom(key) {
    const r = ROOMS[key] || ROOMS.cardboard;
    this.focusX = r.x;
  }

  updateCamera(dt, follow) {
    const o = this.camOrbit;
    const fx = follow ? follow.x : (this.focusX ?? ROOMS.cardboard.x);
    const fz = follow ? follow.z : -1;
    this.camTarget.lerp(new THREE.Vector3(fx, 1.5, fz * 0.4), Math.min(1, dt * 2.6));
    const want = new THREE.Vector3(
      this.camTarget.x + Math.sin(o.yaw) * o.dist * Math.cos(o.pitch),
      1.6 + Math.sin(o.pitch) * o.dist,
      this.camTarget.z + Math.cos(o.yaw) * o.dist * Math.cos(o.pitch)
    );
    this.camPos.lerp(want, Math.min(1, dt * 3.2));
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camTarget);
  }

  resize(w, h) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  tick(t, dt) {
    if (this.signs) for (const s of this.signs) s.rotation.z = Math.sin(t * 0.7 + s.userData.sway) * 0.018;
    if (this.cardWheel) this.cardWheel.rotation.x = t * 0.06;
    if (this.grindWheel) this.grindWheel.rotation.x = t * 4;
    if (this.shopLamp) this.shopLamp.rotation.z = Math.sin(t * 0.5) * 0.03;
    if (this.crt) this.crt.material.emissiveIntensity = 0.75 + Math.sin(t * 9) * 0.12;

    // finished parts sliding down the bench onto the staging rack
    if (this.stageTweens) {
      for (let i = this.stageTweens.length - 1; i >= 0; i--) {
        const s = this.stageTweens[i];
        s.t = Math.min(1, s.t + dt / s.dur);
        const k = s.t < 0.5 ? 2 * s.t * s.t : 1 - Math.pow(-2 * s.t + 2, 2) / 2;
        s.mesh.position.lerpVectors(s.from, s.to, k);
        s.mesh.position.y += Math.sin(k * Math.PI) * 0.16;
        if (s.t >= 1) this.stageTweens.splice(i, 1);
      }
    }
  }

  /* The CAD bench scissors itself into part of this same canvas, so the
     shop has to put the viewport back before it draws. */
  render() {
    const size = this.renderer.getSize(new THREE.Vector2());
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, size.x, size.y);
    this.renderer.render(this.scene, this.camera);
  }
}
