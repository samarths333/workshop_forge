/* =====================================================================
   The bench — a CAD workspace for the thing on the pedestal.

   Watching a robot walk across a shop is a bad way to find out why a build
   does not read as a lamp. This is the other way to look at it: the whole
   assembly, alone, on a grid, in orthographic, with the attach tree beside
   it and an explode slider to pull it apart.

   And because looking is only half of it, every field is editable. Change
   a shape, a size, what a part is bolted to, and the assembly re-solves
   under your hands. The corrected version is what gets taught back to the
   skill library — the model got it wrong, you fixed it once, and the next
   build of that class starts from your version.

   Renders into the same canvas and the same WebGL context as the shop,
   scissored into the gap between the two panels. One context, no second
   renderer, and the shop keeps simulating behind it.
   ===================================================================== */

import * as THREE from 'three';
import { partGeometry, partMaterial, previewGeometry } from './shapes.js';
import { SHAPES, MATERIALS, FACES, ARRAY_MODES } from './assembly.js';
import { allShapes, shapeDef, customShapes, newShapeFrom, validateShapeDef, SHAPE_KINDS } from './shapelib.js';
import { cubeFaceTex } from './textures.js';
import { describeEngine } from './engine.js';
import {
  assemblyMetrics, partMetrics, measureBetween,
  formatLen, formatMass, formatVolume, toUnit, parseLen, UNITS
} from './metrics.js';

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* which way a part travels when the assembly is exploded, if its position
   relative to its parent does not make that obvious on its own */
const FACE_DIR = {
  top: [0, 1, 0], bottom: [0, -1, 0], left: [-1, 0, 0],
  right: [1, 0, 0], front: [0, 0, 1], back: [0, 0, -1], inside: [0, 1, 0]
};

const VIEWS = {
  front:  { yaw: 0,             pitch: 0 },
  back:   { yaw: Math.PI,       pitch: 0 },
  right:  { yaw: Math.PI / 2,   pitch: 0 },
  left:   { yaw: -Math.PI / 2,  pitch: 0 },
  top:    { yaw: 0,             pitch: Math.PI / 2 - 0.001 },
  bottom: { yaw: 0,             pitch: -Math.PI / 2 + 0.001 },
  iso:    { yaw: 0.72,          pitch: 0.52 }
};

export class CadView {
  constructor({ renderer, tex, env, dom }) {
    this.renderer = renderer;
    this.tex = tex;
    this.dom = dom;
    this.active = false;

    this.plan = null;
    this.parts = [];
    this.solved = null;
    this.selected = null;                 // index into parts (a part SPEC)
    this.hidden = new Set();
    this.mode = 'shaded';
    this.explodeAmount = 0;
    this.ortho = false;
    this.onEdit = null;                   // (index, patch) → app re-solves
    this.onEngineEdit = null;             // (set) → app re-sizes the whole engine
    this.onCommand = null;                // ('add' | 'delete' | 'teach' | 'rebuild')

    /* Nobody works in metres. The shop does, the solver does, and every
       number a person reads or types here is millimetres unless they say
       otherwise — which is the difference between a model viewer and
       something you can actually dimension a part in. */
    this.unit = 'mm';
    this.measure = { on: false, a: null, b: null, result: null };
    this.isolated = false;
    this.section = { on: false, axis: 0, offset: 0 };
    /* The shape being drawn, when somebody is drawing one. Declared here
       rather than sprung into existence by openShapes, so every field this
       view owns is in one place. */
    this.shapeEd = null;
    this.previewMesh = null;
    this.clipPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);

    /* ---- scene ---- */
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x101216);
    if (env) this.scene.environment = env;

    this.scene.add(new THREE.HemisphereLight(0xbdd2e6, 0x2a2622, 0.5));
    const key = new THREE.DirectionalLight(0xfff4e4, 1.5);
    key.position.set(4, 7, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    Object.assign(key.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 0.1, far: 24 });
    key.shadow.camera.updateProjectionMatrix();
    const fill = new THREE.DirectionalLight(0x9fc4ff, 0.5);
    fill.position.set(-5, 3, -4);
    const rim = new THREE.DirectionalLight(0xffd7a8, 0.6);
    rim.position.set(0, 2, -7);
    this.scene.add(key, fill, rim);

    /* ---- the grid: 100mm squares, a metre highlighted ---- */
    const fine = new THREE.GridHelper(8, 80, 0x2a3038, 0x1c2128);
    const coarse = new THREE.GridHelper(8, 8, 0x3f4c5c, 0x323c48);
    fine.position.y = -0.001;
    for (const g of [fine, coarse]) { g.material.transparent = true; g.material.opacity = 0.75; }
    this.scene.add(fine, coarse);

    // the pedestal footprint, so you can see what has to fit on it
    const pad = new THREE.Mesh(
      new THREE.PlaneGeometry(1.9, 1.9),
      new THREE.MeshBasicMaterial({ color: 0x2b3a4a, transparent: true, opacity: 0.35, depthWrite: false })
    );
    pad.rotation.x = -Math.PI / 2;
    pad.position.y = 0.002;
    this.scene.add(pad);

    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.meshes = [];

    this.box = new THREE.Box3Helper(new THREE.Box3(), 0xffa94d);
    this.box.visible = false;
    this.scene.add(this.box);

    /* ---- cameras ---- */
    this.fov = 34;
    this.orbit = { yaw: VIEWS.iso.yaw, pitch: VIEWS.iso.pitch, dist: 4, target: new THREE.Vector3(0, 0.5, 0) };
    this.persp = new THREE.PerspectiveCamera(this.fov, 1, 0.05, 200);
    this.orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -100, 200);
    this.camera = this.persp;

    this.buildViewCube();
    this.ray = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();
    this.viewport = { x: 0, y: 0, w: 1, h: 1 };
  }

  /* ---------------------------------------------------------------- */
  /* the orientation cube, bottom right                               */
  /* ---------------------------------------------------------------- */
  buildViewCube() {
    this.cubeScene = new THREE.Scene();
    this.cubeCam = new THREE.OrthographicCamera(-1.7, 1.7, 1.7, -1.7, 0.1, 20);
    // BoxGeometry material order is +x, -x, +y, -y, +z, -z
    const faces = ['RIGHT', 'LEFT', 'TOP', 'BOT', 'FRONT', 'BACK'];
    const mats = faces.map(f => new THREE.MeshBasicMaterial({ map: cubeFaceTex(f) }));
    this.cube = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.6, 1.6), mats);
    this.cubeScene.add(this.cube);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(this.cube.geometry),
      new THREE.LineBasicMaterial({ color: 0x6b7a8c })
    );
    this.cubeScene.add(edges);
    this.cubeEdges = edges;
  }

  /* ---------------------------------------------------------------- */
  /* model                                                             */
  /* ---------------------------------------------------------------- */
  setModel(plan, parts, solved) {
    this.plan = plan;
    this.parts = parts || [];
    this.solved = solved;
    if (this.selected != null && this.selected >= this.parts.length) this.selected = null;
    this.rebuild();
    this.renderPanels();
  }

  rebuild() {
    for (const m of this.meshes) {
      this.group.remove(m.mesh);
      m.mesh.geometry.dispose();
      m.mesh.material.dispose();
      m.edges.geometry.dispose();
      m.edges.material.dispose();
    }
    this.meshes = [];
    if (!this.solved) return;

    const byId = new Map(this.solved.instances.map(i => [i.i, i]));

    for (const inst of this.solved.instances) {
      const mesh = new THREE.Mesh(
        partGeometry(inst.shape, inst.size),
        partMaterial(inst.material, inst.color, this.tex)
      );
      mesh.castShadow = mesh.receiveShadow = true;
      const s = inst.scale || 1;
      mesh.scale.set(s, s, s);
      mesh.rotation.set(inst.rot[0], inst.rot[1], inst.rot[2]);
      mesh.userData.src = inst.src;
      mesh.userData.inst = inst;
      // glass is transparent to begin with; x-ray must not "restore" it to solid
      mesh.userData.baseTransparent = mesh.material.transparent;
      mesh.userData.baseOpacity = mesh.material.opacity;

      // shaded-with-edges gets real edge lines, not a wireframe overlay
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(mesh.geometry, 24),
        new THREE.LineBasicMaterial({ color: 0x0a0c10, transparent: true, opacity: 0.55 })
      );
      edges.raycast = () => {};
      mesh.add(edges);

      // which way it flies when the assembly comes apart
      const parent = inst.parent != null ? byId.get(inst.parent) : null;
      let dir = new THREE.Vector3();
      if (parent) {
        dir.set(inst.pos[0] - parent.pos[0], inst.pos[1] - parent.pos[1], inst.pos[2] - parent.pos[2]);
      }
      if (dir.lengthSq() < 1e-6) {
        const f = FACE_DIR[inst.face] || [0, 1, 0];
        dir.set(f[0], f[1], f[2]);
      }
      dir.normalize();

      let depth = 0;
      for (let p = inst.parent, guard = 0; p != null && guard < 12; guard++) {
        depth++;
        p = byId.get(p)?.parent;
      }

      this.group.add(mesh);
      this.meshes.push({ mesh, edges, inst, home: new THREE.Vector3(...inst.pos), dir, depth });
    }

    this.applyExplode();
    this.applyMode();
    this.applySelection();
    // fresh materials come back without the cutting plane on them
    if (this.section.on) this.setSection({});
  }

  applyExplode() {
    const k = this.explodeAmount;
    for (const m of this.meshes) {
      const d = 0.28 + 0.22 * m.depth;
      m.mesh.position.copy(m.home).addScaledVector(m.dir, k * d);
    }
  }

  applyMode() {
    for (const m of this.meshes) {
      const mat = m.mesh.material;
      const hidden = this.hidden.has(m.inst.src);
      // the mesh always stays in the scene even in wireframe, or there
      // would be nothing left to click on
      m.mesh.visible = !hidden;
      m.edges.visible = !hidden && this.mode !== 'shaded';
      mat.wireframe = this.mode === 'wire';

      const xray = this.mode === 'xray' && m.inst.src !== this.selected;
      mat.transparent = xray || m.mesh.userData.baseTransparent;
      mat.opacity = xray ? 0.16 : m.mesh.userData.baseOpacity;
      mat.depthWrite = !xray;
      m.edges.material.opacity = this.mode === 'xray' ? 0.3 : (m.inst.src === this.selected ? 0.95 : 0.55);
      mat.needsUpdate = true;
    }
  }

  applySelection() {
    let found = null;
    for (const m of this.meshes) {
      const on = m.inst.src === this.selected;
      if (on && !found) found = m;
      const mat = m.mesh.material;
      if (mat.emissive) {
        mat.emissive.setHex(on ? 0x2f6ea8 : 0x000000);
        mat.emissiveIntensity = on ? 0.55 : 0;
      }
      m.edges.material.color.setHex(on ? 0xffa94d : 0x0a0c10);
      m.edges.material.opacity = on ? 0.95 : 0.55;
    }
    if (found) {
      // the mesh may have been moved this same tick by the explode slider,
      // and setFromObject reads world matrices
      found.mesh.updateWorldMatrix(true, true);
      // precise: measure the actual vertices, not the corners of the
      // geometry's own box put through the rotation — otherwise a turned
      // cone gets a selection box half again too big
      this.box.box.setFromObject(found.mesh, true);
      this.box.visible = true;
    } else {
      this.box.visible = false;
    }
  }

  select(src) {
    this.selected = src;
    this.applySelection();
    this.applyMode();
    this.renderPanels();
  }

  toggleHidden(src) {
    if (this.hidden.has(src)) this.hidden.delete(src); else this.hidden.add(src);
    this.applyMode();
    this.renderPanels();
  }

  setMode(m) { this.mode = m; this.applyMode(); this.applySelection(); }
  setExplode(v) { this.explodeAmount = v; this.applyExplode(); this.applySelection(); }

  /* ---------------------------------------------------------------- */
  /* units, measuring, isolating, sectioning                           */
  /* ---------------------------------------------------------------- */
  setUnit(u) {
    this.unit = UNITS.includes(u) ? u : 'mm';
    this.renderPanels(true);
  }

  /* A length field shows and accepts the current unit; everything else is
     passed through untouched. Kept here so app.js never has to know what
     the panel is currently displaying in. */
  fieldToSpec(field, raw) {
    if (!['sx', 'sy', 'sz', 'dx', 'dy', 'dz', 'radius'].includes(field)) return raw;
    const m = parseLen(raw, this.unit);
    return m == null ? raw : m;
  }

  toggleMeasure(on) {
    this.measure.on = on ?? !this.measure.on;
    this.measure.a = this.measure.b = null;
    this.measure.result = null;
    this.renderStats();
    return this.measure.on;
  }

  /* Click two parts and get the number that actually matters: the air
     between them, and which way they are closest to fouling. */
  measurePick(src) {
    if (!this.measure.on || src == null) return;
    const m = this.measure;
    if (m.a == null || m.b != null) { m.a = src; m.b = null; m.result = null; }
    else if (src !== m.a) {
      m.b = src;
      const A = this.solved?.instances.find(i => i.src === m.a);
      const B = this.solved?.instances.find(i => i.src === m.b);
      m.result = measureBetween(A, B);
    }
    this.renderStats();
  }

  /* Everything except the selected part out of the way. On a forty-part
     assembly this is the only way to see what you are editing. */
  toggleIsolate() {
    this.isolated = !this.isolated;
    if (this.isolated && this.selected != null) {
      this.hidden = new Set(this.parts.map((_, i) => i).filter(i => i !== this.selected));
    } else {
      this.hidden = new Set();
      this.isolated = false;
    }
    this.applyMode();
    this.renderPanels();
    return this.isolated;
  }

  /* A cutting plane through the assembly. Half of what a section view is
     for is checking that the inside of something is not solid. */
  setSection(patch = {}) {
    Object.assign(this.section, patch);
    const s = this.section;
    const n = [[-1, 0, 0], [0, -1, 0], [0, 0, -1]][s.axis] || [-1, 0, 0];
    // normal points back down the axis, so the plane keeps everything on
    // the near side of the offset and cuts away the rest
    this.clipPlane.normal.set(n[0], n[1], n[2]);
    this.clipPlane.constant = s.offset;
    this.renderer.localClippingEnabled = s.on;
    for (const m of this.meshes) {
      m.mesh.material.clippingPlanes = s.on ? [this.clipPlane] : null;
      m.mesh.material.clipShadows = s.on;
      m.mesh.material.needsUpdate = true;
    }
  }

  setView(name) {
    const v = VIEWS[name] || VIEWS.iso;
    this.orbit.yaw = v.yaw;
    this.orbit.pitch = v.pitch;
    // proportions are a lie in perspective; a snapped view goes orthographic
    if (name !== 'iso') this.setOrtho(true);
    this.dom.root.querySelectorAll('[data-view]').forEach(b =>
      b.classList.toggle('on', b.dataset.view === name));
  }

  setOrtho(on) {
    this.ortho = on;
    this.camera = on ? this.orthoCam : this.persp;
    this.dom.root.querySelectorAll('[data-proj]').forEach(b =>
      b.classList.toggle('on', (b.dataset.proj === 'ortho') === on));
  }

  frameAll() {
    if (!this.solved || !this.solved.instances.length) {
      this.orbit.target.set(0, 0.5, 0); this.orbit.dist = 4;
      return;
    }
    const b = new THREE.Box3().setFromObject(this.group);
    const c = b.getCenter(new THREE.Vector3());
    const size = b.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z, 0.4) * 0.5;
    this.orbit.target.copy(c);
    this.orbit.dist = (radius / Math.tan((this.fov * Math.PI) / 360)) * 2.1;
  }

  /* ---------------------------------------------------------------- */
  /* camera + drawing                                                  */
  /* ---------------------------------------------------------------- */
  layout(stageW, stageH) {
    const padL = this.dom.tree.offsetWidth || 0;
    const padR = this.dom.side.offsetWidth || 0;
    this.viewport = {
      x: padL, y: 0,
      w: Math.max(32, stageW - padL - padR),
      h: Math.max(32, stageH)
    };
  }

  updateCamera() {
    const o = this.orbit;
    const aspect = this.viewport.w / this.viewport.h;
    const dir = new THREE.Vector3(
      Math.sin(o.yaw) * Math.cos(o.pitch),
      Math.sin(o.pitch),
      Math.cos(o.yaw) * Math.cos(o.pitch)
    );
    const pos = dir.clone().multiplyScalar(o.dist).add(o.target);

    this.persp.aspect = aspect;
    this.persp.position.copy(pos);
    this.persp.lookAt(o.target);
    this.persp.updateProjectionMatrix();

    // matching framing so toggling projection does not jump the model
    const h = 2 * o.dist * Math.tan((this.fov * Math.PI) / 360);
    const w = h * aspect;
    Object.assign(this.orthoCam, { left: -w / 2, right: w / 2, top: h / 2, bottom: -h / 2 });
    this.orthoCam.position.copy(pos);
    this.orthoCam.lookAt(o.target);
    this.orthoCam.updateProjectionMatrix();
  }

  render() {
    this.updateCamera();
    const r = this.renderer, v = this.viewport;
    r.setScissorTest(true);
    r.setViewport(v.x, v.y, v.w, v.h);
    r.setScissor(v.x, v.y, v.w, v.h);
    r.render(this.scene, this.camera);

    // the orientation cube, composited over the bottom-right corner.
    // autoClear off so it lands on top of the model rather than punching a
    // black square through it.
    const s = 96;
    const cx = v.x + v.w - s - 14, cy = v.y + 14;
    r.setViewport(cx, cy, s, s);
    r.setScissor(cx, cy, s, s);
    this.cube.quaternion.copy(this.camera.quaternion).invert();
    this.cubeEdges.quaternion.copy(this.cube.quaternion);
    this.cubeCam.position.set(0, 0, 6);
    this.cubeCam.lookAt(0, 0, 0);
    r.autoClear = false;
    r.clearDepth();
    r.render(this.cubeScene, this.cubeCam);
    r.autoClear = true;
    this.cubeRect = { x: cx, y: cy, s };

    r.setScissorTest(false);
  }

  /* ---------------------------------------------------------------- */
  /* picking                                                           */
  /* ---------------------------------------------------------------- */
  /* px, py are in CSS pixels from the top-left of the stage */
  pick(px, py, stageH) {
    const v = this.viewport;
    const glY = stageH - py;                       // GL counts from the bottom

    // the cube first — it sits on top
    const c = this.cubeRect;
    if (c && px >= c.x && px <= c.x + c.s && glY >= c.y && glY <= c.y + c.s) {
      this.ndc.set(((px - c.x) / c.s) * 2 - 1, ((glY - c.y) / c.s) * 2 - 1);
      this.ray.setFromCamera(this.ndc, this.cubeCam);
      const hit = this.ray.intersectObject(this.cube, false)[0];
      // face.normal is in the cube's own space, and the cube's own axes are
      // the model's axes — that is the whole point of the labels
      if (hit) return { cube: faceFromNormal(hit.face.normal) };
      return { cube: null };
    }

    if (px < v.x || px > v.x + v.w) return null;
    this.ndc.set(((px - v.x) / v.w) * 2 - 1, ((glY - v.y) / v.h) * 2 - 1);
    this.ray.setFromCamera(this.ndc, this.camera);
    const targets = this.meshes.filter(m => m.mesh.visible).map(m => m.mesh);
    const hit = this.ray.intersectObjects(targets, false)[0];
    return { part: hit ? hit.object.userData.src : null };
  }

  /* ---------------------------------------------------------------- */
  /* the browser tree and the properties panel                         */
  /* ---------------------------------------------------------------- */
  renderPanels(force) {
    this.renderTree();
    this.renderProps(force);
    this.renderStats();
  }

  renderTree() {
    const el = this.dom.tree.querySelector('.cadTreeBody');
    if (!this.parts.length) {
      el.innerHTML = '<p class="fine empty">Nothing on the bench. Ask Rivet to build something and it lands here, part by part.</p>';
      return;
    }
    const children = new Map();
    const roots = [];
    this.parts.forEach((p, i) => {
      const to = p.attach ? p.attach.to : null;
      if (to == null || to >= i) roots.push(i);
      else {
        if (!children.has(to)) children.set(to, []);
        children.get(to).push(i);
      }
    });

    const counts = new Map();
    if (this.solved) for (const inst of this.solved.instances) counts.set(inst.src, (counts.get(inst.src) || 0) + 1);

    const drawn = new Set();
    const row = (i, depth) => {
      if (drawn.has(i) || depth > 10) return '';      // a malformed tree cannot hang the panel
      drawn.add(i);
      const p = this.parts[i];
      const n = counts.get(i) || 1;
      const hid = this.hidden.has(i);
      const sel = this.selected === i;
      const face = p.attach ? p.attach.face : null;
      return `<div class="cadRow${sel ? ' sel' : ''}${hid ? ' hid' : ''}" data-part="${i}" style="padding-left:${8 + depth * 13}px">
          <button class="cadEye" data-eye="${i}" title="show / hide">${hid ? '○' : '●'}</button>
          <span class="cadIcon">${iconFor(p.shape)}</span>
          <span class="cadName">${esc(p.name || p.shape)}</span>
          ${n > 1 ? `<span class="cadMul">×${n}</span>` : ''}
          ${face ? `<span class="cadFace">${face}</span>` : '<span class="cadFace root">ground</span>'}
        </div>` + (children.get(i) || []).map(c => row(c, depth + 1)).join('');
    };
    el.innerHTML = roots.map(i => row(i, 0)).join('');
  }

  renderProps(force) {
    const el = this.dom.side.querySelector('.cadPropsBody');
    /* Every keystroke re-solves the assembly, and re-solving re-renders this
       panel. Rebuilding the DOM under a field you are still typing in throws
       away the caret after every character, so while a field has focus the
       panel is left alone and refreshed on commit instead. */
    const active = document.activeElement;
    if (!force && active && el.contains(active) && active.tagName === 'INPUT') return;

    const i = this.selected;
    if (i == null || !this.parts[i]) {
      el.innerHTML = '<p class="fine empty">Pick a part — in the viewport or in the tree — to change what it is, how big it is and what it is bolted to. The assembly re-solves as you type.</p>';
      return;
    }
    const p = this.parts[i];
    const opt = (list, v) => list.map(o => `<option value="${o}"${o === v ? ' selected' : ''}>${o}</option>`).join('');
    const parents = this.parts
      .map((q, j) => ({ q, j }))
      .filter(({ j }) => j < i)
      .map(({ q, j }) => `<option value="${j}"${p.attach && p.attach.to === j ? ' selected' : ''}>${j} · ${esc(q.name || q.shape)}</option>`)
      .join('');
    const rot = (p.rot || [0, 0, 0]).map(r => Math.round((r * 180) / Math.PI));
    const arr = p.array || {};
    const u = this.unit;
    // fields carry the current unit, and the step follows it — 1mm steps
    // in millimetres, not the 0.02m that made the arrows useless
    const L = v => +toUnit(Number(v) || 0, u).toFixed(u === 'm' ? 3 : 1);
    const step = { mm: 1, cm: 0.1, m: 0.01 }[u];
    const inst = this.solved?.instances.find(x => x.src === i);
    const pm = inst ? partMetrics(inst) : null;

    el.innerHTML = `
      ${this.engineFields()}
      <label class="cadF"><span>Name</span><input data-f="name" value="${esc(p.name || '')}"></label>
      <div class="cadPair">
        <label class="cadF"><span>Shape</span>
          <span class="cadShapeRow">
            <select data-f="shape">${shapeOptions(p.shape)}</select>
            <button class="cadMini" data-cmd="shapes" title="Make a shape of your own">✎</button>
          </span>
        </label>
        <label class="cadF"><span>Material</span><select data-f="material">${opt(MATERIALS, p.material)}</select></label>
      </div>
      <div class="cadTrip">
        <label class="cadF"><span>Width ${u}</span><input type="number" step="${step}" data-f="sx" value="${L(p.size[0])}"></label>
        <label class="cadF"><span>Height ${u}</span><input type="number" step="${step}" data-f="sy" value="${L(p.size[1])}"></label>
        <label class="cadF"><span>Depth ${u}</span><input type="number" step="${step}" data-f="sz" value="${L(p.size[2])}"></label>
      </div>
      ${pm ? `<div class="cadMetrics">
        <span title="estimated from the primitive, not a solid model">${formatVolume(pm.volume)}</span>
        <span>${formatMass(pm.mass)} in ${esc(p.material)}</span>
        <span>${(pm.density).toFixed(0)} kg/m³</span>
      </div>` : ''}
      <div class="cadTrip">
        <label class="cadF"><span>Rot X°</span><input type="number" step="15" min="-180" max="180" data-f="rx" value="${rot[0]}"></label>
        <label class="cadF"><span>Rot Y°</span><input type="number" step="15" min="-180" max="180" data-f="ry" value="${rot[1]}"></label>
        <label class="cadF"><span>Rot Z°</span><input type="number" step="15" min="-180" max="180" data-f="rz" value="${rot[2]}"></label>
      </div>

      <h4>Bolted to</h4>
      <div class="cadPair">
        <label class="cadF"><span>Part</span><select data-f="to">
          <option value="">— stands on the pedestal —</option>${parents}
        </select></label>
        <label class="cadF"><span>Face</span><select data-f="face"${p.attach ? '' : ' disabled'}>${opt(FACES, p.attach ? p.attach.face : 'top')}</select></label>
      </div>
      <div class="cadTrip">
        <label class="cadF"><span>Offset X ${u}</span><input type="number" step="${step}" data-f="dx" value="${L(p.attach?.dx ?? 0)}"${p.attach ? '' : ' disabled'}></label>
        <label class="cadF"><span>Offset Y ${u}</span><input type="number" step="${step}" data-f="dy" value="${L(p.attach?.dy ?? 0)}"${p.attach ? '' : ' disabled'}></label>
        <label class="cadF"><span>Offset Z ${u}</span><input type="number" step="${step}" data-f="dz" value="${L(p.attach?.dz ?? 0)}"${p.attach ? '' : ' disabled'}></label>
      </div>

      <h4>How many</h4>
      <div class="cadTrip">
        <label class="cadF"><span>Pattern</span><select data-f="mode">${opt(ARRAY_MODES, arr.mode || 'none')}</select></label>
        <label class="cadF"><span>Count</span><input type="number" step="1" min="2" max="8" data-f="count" value="${arr.count ?? 4}"></label>
        <label class="cadF"><span>Spread ${u}</span><input type="number" step="${step}" data-f="radius" value="${L(arr.radius ?? 0.4)}"></label>
      </div>

      <button class="cadDelete" data-cmd="delete">Scrap this part</button>`;
  }

  /* The governing dimensions, when there is an engine on the bench. These
     are the ONLY numbers worth editing on an engine — change the bore and
     every part re-sizes off it, which is what makes this different from
     the size fields below, where a number is just that part's number.
     Everything is in the units the engine is quoted in (mm, degrees, rpm),
     deliberately NOT in the panel's unit: nobody specifies a bore in
     metres, and converting it would make the field unreadable. */
  engineFields() {
    const e = this.plan?.engine;
    if (!e) return '';
    const N = (f, label, v, step = 1, min = 0) =>
      `<label class="cadF"><span>${label}</span><input type="number" step="${step}" min="${min}" data-e="${f}" value="${Math.round(Number(v) * 100) / 100}"></label>`;

    let rows;
    if (e.kind === 'ice') {
      rows = `
      <div class="cadTrip">
        ${N('bore', 'Bore mm', e.bore)}${N('stroke', 'Stroke mm', e.stroke)}${N('rod', 'Rod mm', e.rod)}
      </div>
      <div class="cadTrip">
        ${N('chamber', 'Chamber cc', e.chamber, 0.5)}${N('cylinders', 'Cylinders', e.cylinders)}${N('redline', 'Redline rpm', e.redline, 100)}
      </div>`;
    } else if (e.kind === 'turbofan') {
      rows = `
      <div class="cadTrip">
        ${N('fanDiameter', 'Fan mm', e.fanDiameter, 10)}${N('bypassRatio', 'Bypass', e.bypassRatio, 0.5)}${N('overallPressureRatio', 'OPR', e.overallPressureRatio, 1)}
      </div>
      <div class="cadTrip">
        ${N('massFlow', 'Core kg/s', e.massFlow, 0.5)}${N('fanTipMach', 'Tip Mach', e.fanTipMach, 0.05)}${N('lpcPR', 'Booster PR', e.lpcPR, 0.1)}
      </div>`;
    } else {
      rows = `
      <div class="cadTrip">
        ${N('statorOD', 'Stator OD mm', e.statorOD)}${N('statorID', 'Bore mm', e.statorID)}${N('stackLength', 'Stack mm', e.stackLength)}
      </div>
      <div class="cadTrip">
        ${N('slots', 'Slots', e.slots)}${N('poles', 'Poles', e.poles)}${N('kv', 'Kv', e.kv, 10)}
      </div>`;
    }
    return `<h4>The engine — every part is sized from these</h4>${rows}<div class="cadEngineNote">${esc(describeEngine(this.plan).split('\n')[0])}</div>`;
  }

  /* ---------------------------------------------------------------- *
   * the shape editor                                                  *
   * ---------------------------------------------------------------- */
  /* Nine shapes used to be all there was, and a tenth was a code change.
     A shape is a profile now, so this is a table of numbers with a picture
     next to it — which is the honest UI for the thing it edits.

     Two rules it does not bend. Editing always starts from a shape that
     already exists, because nobody authors a profile from an empty list;
     and the preview is drawn by the SAME partGeometry the shop uses, not
     by a second drawing path, so what is on screen is what gets built. */
  openShapes(startFrom) {
    this.shapeEd = this.shapeEd || {};
    const from = startFrom || this.parts[this.selected]?.shape || 'cylinder';
    const draft = newShapeFrom(from, uniqueShapeId(from), `My ${from}`);
    this.shapeEd.draft = draft;
    this.shapeEd.open = !!draft;
    this.shapeEd.error = '';
    this.renderShapes();
  }

  closeShapes() {
    if (this.shapeEd) this.shapeEd.open = false;
    this.renderShapes();
  }

  refreshShapes() {
    this.renderProps(true);
    this.renderShapes();
  }

  /* The points, as a text area. A grid of number inputs was the obvious
     design and it is wrong: a profile is 6 to 30 pairs, the useful edit is
     "paste a different profile" or "nudge four of them", and both are
     miserable through thirty spinners. One pair per line, and anything
     that will not parse leaves the last good preview up. */
  renderShapes() {
    const el = this.dom.shapes;
    if (!el) return;
    const ed = this.shapeEd;
    if (!ed?.open || !ed.draft) { el.style.display = 'none'; el.innerHTML = ''; this.updateShapePreview(); return; }
    el.style.display = '';
    this.updateShapePreview();

    const d = ed.draft;
    const pts = d.kind === 'revolve' ? d.profile : d.outline;
    const mine = customShapes();
    const text = ed.text !== undefined ? ed.text : pts.map(pr => `${round3(pr[0])} ${round3(pr[1])}`).join('\n');

    el.innerHTML = `
      <div class="cadShapeHead">
        <b>Make a shape</b>
        <button class="cadMini" data-sh="close" title="Close">✕</button>
      </div>
      <div class="cadPair">
        <label class="cadF"><span>Name</span><input data-sh="id" value="${esc(d.id)}"></label>
        <label class="cadF"><span>Swept</span><select data-sh="kind">
          ${SHAPE_KINDS.map(k => `<option value="${k}"${k === d.kind ? ' selected' : ''}>${k === 'revolve' ? 'turned on a lathe' : 'cut from sheet'}</option>`).join('')}
        </select></label>
      </div>
      <label class="cadF"><span>Start from</span><select data-sh="from">
        ${allShapes().map(o => `<option value="${o.id}">${esc(o.label)}</option>`).join('')}
      </select></label>
      <div class="cadShapeHint">${d.kind === 'revolve'
        ? 'One point per line: <b>radius height</b>, both 0 to 1, bottom to top. It is spun about the upright.'
        : 'One point per line: <b>across up</b>, both 0 to 1, going round the outline. It is pushed out to the depth you set.'}</div>
      <textarea class="cadShapePts" data-sh="pts" spellcheck="false" rows="9">${esc(text)}</textarea>
      <div class="cadShapeErr">${esc(ed.error || '')}</div>
      <div class="cadShapeBtns">
        <button data-sh="save">Save it</button>
        <button data-sh="cancel">Cancel</button>
      </div>
      ${mine.length ? `<h4>Yours</h4><div class="cadShapeMine">${mine.map(m => `
        <span class="cadChip">${esc(m.id)}
          <button class="cadMini" data-sh="edit" data-id="${esc(m.id)}" title="Start a new one from this">✎</button>
          <button class="cadMini" data-sh="drop" data-id="${esc(m.id)}" title="Delete">✕</button>
        </span>`).join('')}</div>` : ''}`;
  }

  /* THE PREVIEW, drawn by the same partGeometry the shop builds with — not
     by a second drawing path. A preview with its own renderer is a preview
     that can be right about a shape the floor then gets wrong, which is
     the one thing it must never be. It stands beside the assembly at a
     size that reads next to it. */
  updateShapePreview() {
    const ed = this.shapeEd;
    const want = ed?.open && ed.draft ? ed.draft : null;

    if (!want) {
      if (this.previewMesh) {
        this.group.remove(this.previewMesh);
        this.previewMesh.geometry.dispose();
        this.previewMesh.material.dispose();
        this.previewMesh = null;
      }
      return;
    }

    /* The draft is not in the registry until it is saved, so it is drawn
       from its definition directly — same function, same normalisation. */
    const size = [0.5, 0.5, 0.5];
    const geo = definedPreviewGeometry(want, size);
    if (!geo) return;

    if (!this.previewMesh) {
      this.previewMesh = new THREE.Mesh(geo, partMaterial('alloy', null, this.tex));
      this.previewMesh.userData.preview = true;
      this.previewMesh.raycast = () => {};
      this.group.add(this.previewMesh);
    } else {
      this.previewMesh.geometry.dispose();
      this.previewMesh.geometry = geo;
    }

    /* Beside whatever is on the bench, never through it. */
    const span = this.solved ? Math.max(0.4, this.solved.size?.[0] || 0.8) : 0.8;
    this.previewMesh.position.set(span / 2 + 0.55, 0.3, 0);
  }

  /* Parse what is in the box back into a draft. Called on every keystroke,
     so it must never throw and must never lose what is being typed —
     a half-finished line is a line that does not parse yet, not an error. */
  editShapeText(text) {
    const ed = this.shapeEd;
    if (!ed?.draft) return;
    ed.text = text;
    const pts = text.split(/\n+/).map(line => {
      const m = line.trim().split(/[\s,]+/).map(Number);
      return m.length >= 2 && m.every(Number.isFinite) ? [m[0], m[1]] : null;
    }).filter(Boolean);
    if (pts.length < 3) { ed.error = 'three points or more'; return; }
    const next = { ...ed.draft };
    if (next.kind === 'revolve') next.profile = pts; else next.outline = pts;
    const clean = validateShapeDef(next);
    if (!clean) { ed.error = 'that profile sweeps nothing — give it some height and some width'; return; }
    ed.error = '';
    ed.draft = clean;
    this.updateShapePreview();
  }

  setShapeField(field, value) {
    const ed = this.shapeEd;
    if (!ed?.draft) return;
    if (field === 'id') { ed.draft.id = String(value).toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 32); return; }
    if (field === 'kind' && SHAPE_KINDS.includes(value) && value !== ed.draft.kind) {
      /* Switching how it is swept keeps the points — a profile read as an
         outline is a different shape but a sensible starting one, and
         throwing the numbers away on a mis-click is not. */
      const pts = ed.draft.kind === 'revolve' ? ed.draft.profile : ed.draft.outline;
      ed.draft = validateShapeDef({ ...ed.draft, kind: value, profile: pts, outline: pts }) || ed.draft;
      ed.text = undefined;
      this.renderShapes();
    }
    if (field === 'from') {
      const next = newShapeFrom(value, ed.draft.id, ed.draft.label);
      if (next) { ed.draft = next; ed.text = undefined; ed.error = ''; this.renderShapes(); }
    }
  }

  /* The numbers a person checks before they commit to cutting anything:
     how big, how heavy, what it is made of, and whether it will stand up. */
  renderStats() {
    const el = this.dom.stats;
    if (!this.solved || !this.solved.instances.length) { el.textContent = 'no assembly'; return; }

    const u = this.unit;
    const m = assemblyMetrics(this.solved);
    const dims = m.size.map(v => formatLen(v, u, false)).join(' × ');
    const mats = m.byMaterial.slice(0, 3)
      .map(x => `${x.material} ${formatMass(x.mass)}`).join(' · ');

    const meas = this.measure.on ? measureLine(this.measure, this.parts, u) : '';

    const eng = this.plan?.engine ? describeEngine(this.plan).split('\n').map(l => `<span>${esc(l)}</span>`).join('') : '';

    el.innerHTML =
      `<b>${dims} ${u}</b>` + eng +
      `<span>${m.parts} parts from ${this.parts.length} operations · ${this.solved.joints.length} joints</span>` +
      `<span class="cadNum">${formatMass(m.mass)} · ${formatVolume(m.volume)} of material</span>` +
      (mats ? `<span>${esc(mats)}</span>` : '') +
      `<span>centre of mass ${formatLen(m.com[1], u)} up</span>` +
      (m.stable
        ? `<span class="ok">stands up — mass is over the base</span>`
        : `<span class="warn">it topples: the centre of mass is ${Math.round((m.tipRatio - 1) * 100)}% outside the footprint</span>`) +
      (this.solved.fit < 0.999 ? `<span class="warn">scaled to ${Math.round(this.solved.fit * 100)}% to fit the pedestal</span>` : '') +
      meas;
  }
}

/* ------------------------------------------------------------------ *
 * shape picker helpers                                                *
 * ------------------------------------------------------------------ */
/* Thirty-odd shapes in one flat <select> is a list nobody reads. Grouped
   by how the thing is made, with anything the person made themselves in a
   group of its own at the top — theirs is the one they are looking for. */
function shapeOptions(current) {
  const groups = new Map();
  for (const s of allShapes()) {
    const g = s.custom ? 'yours' : s.group;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }
  const order = ['yours', 'primitive', 'turned', 'section', 'plate'];
  const keys = [...groups.keys()].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return keys.map(g => {
    const rows = groups.get(g)
      .map(o => `<option value="${o.id}"${o.id === current ? ' selected' : ''}>${esc(o.label)}</option>`)
      .join('');
    return `<optgroup label="${esc(g)}">${rows}</optgroup>`;
  }).join('');
}

/* A new shape needs a name nothing else has, and "my_cone_2" beats making
   somebody think of one before they have drawn anything. */
function uniqueShapeId(from) {
  const base = `my_${String(from || 'shape').toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 24);
  const taken = new Set(allShapes().map(s => s.id));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 99; n++) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
  return `${base}_${Date.now() % 1000}`;
}

const round3 = v => Math.round(Number(v) * 1000) / 1000;

/* A draft is not in the registry until it is saved, and partGeometry looks
   shapes UP by id — so the preview goes through the one entry point that
   takes a definition rather than a name. Still the shop's geometry code;
   only the lookup is skipped. */
function definedPreviewGeometry(def, size) {
  try { return previewGeometry(def, size); }
  catch { return null; }
}

/* which named view a clicked cube face corresponds to. BoxGeometry orders
   its material groups +x, -x, +y, -y, +z, -z, which is how the labels were
   assigned, so the local normal maps straight onto a named view. */
function faceFromNormal(v) {
  const ax = [Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)];
  const big = ax.indexOf(Math.max(...ax));
  if (big === 0) return v.x > 0 ? 'right' : 'left';
  if (big === 1) return v.y > 0 ? 'top' : 'bottom';
  return v.z > 0 ? 'front' : 'back';
}

/* The measuring readout. Clearance is the number people came for; centre
   to centre is there because it is the one they will ask for next. */
function measureLine(meas, parts, unit) {
  const name = i => esc(parts[i]?.name || parts[i]?.shape || `part ${i}`);
  if (meas.a == null) return `<span class="cadMeasure">measuring — click the first part</span>`;
  if (meas.b == null) return `<span class="cadMeasure">measuring from <b>${name(meas.a)}</b> — click the second</span>`;
  const r = meas.result;
  if (!r) return `<span class="cadMeasure">nothing to measure</span>`;
  const state = r.interfering
    ? `<b class="warn">interfering by ${formatLen(-r.gap, unit)}</b>`
    : r.touching ? '<b class="ok">touching</b>'
      : `<b>${formatLen(r.gap, unit)} of clearance</b> on ${r.axisName}`;
  return `<span class="cadMeasure">${name(meas.a)} → ${name(meas.b)}<br>${state}` +
    `<br>${formatLen(r.centre, unit)} centre to centre</span>`;
}

function iconFor(shape) {
  return {
    box: '▣', panel: '▤', cylinder: '⬭', rod: '│', cone: '▲',
    sphere: '●', torus: '◎', wedge: '◺', gear: '✳'
  }[shape] || '▣';
}
