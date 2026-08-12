import * as THREE from 'three';
import { cardboardTex, fluteEdgeTex, faceTex } from './textures.js';
import { makeProp, makeHeadgear } from './props.js';
import { CLIP_BY_ID, evalClip, lerpPose, BASE_POSE, JOINTS } from './animations.js';

const V = new THREE.Vector3();
/* scratch for the reach solver — allocating inside a per-frame IK loop is
   how you turn a 60fps shop into a 40fps one */
const JP = new THREE.Vector3(), EP = new THREE.Vector3(), SP = new THREE.Vector3();
const DA = new THREE.Vector3(), DB = new THREE.Vector3(), TG = new THREE.Vector3();
const QQ = new THREE.Quaternion(), QW = new THREE.Quaternion(), QP = new THREE.Quaternion();

const ARM_REACH = 0.95;          // shoulder to tool tip, fully extended

export class Rivet {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    scene.add(this.root);

    const body = cardboardTex(1);
    const edge = fluteEdgeTex(2);
    this.matBody = new THREE.MeshStandardMaterial({ map: body, roughness: 0.94 });
    this.matEdge = new THREE.MeshStandardMaterial({ map: edge, roughness: 0.98 });
    this.faceHappy = faceTex('happy');
    this.faceFocus = faceTex('focus');
    this.matFace = new THREE.MeshStandardMaterial({ map: this.faceHappy, roughness: 0.9 });

    this.j = {};
    this.build();

    this.clip = CLIP_BY_ID.idle;
    this.t = 0;
    this.blend = 1;
    this.fromPose = evalClip(this.clip, 0);
    this.mood = 'happy';

    this.initFx();
    this.workLight = new THREE.PointLight(0xffffff, 0, 6, 2);
    this.root.add(this.workLight);

    /* what he is holding, and what he is reaching for */
    this.carrySlot = new THREE.Group();
    this.carrySlot.position.set(0, 1.18, 0.44);
    this.root.add(this.carrySlot);
    this.carried = [];
    this.reachTarget = null;
    this.reachW = 0;
  }

  /* ---------------- carrying ---------------- */
  /* Parts do not fly to the gallery. He picks them up, they ride in his
     arms, and they are still his problem until he sets them down. */
  carry(mesh) {
    if (!mesh) return;
    if (mesh.parent) mesh.parent.remove(mesh);
    mesh.scale.set(1, 1, 1);
    this.carrySlot.add(mesh);
    this.carried.push(mesh);
    this.arrangeCarried();
  }

  arrangeCarried() {
    let y = 0;
    for (const m of this.carried) {
      const h = (m.userData.size && m.userData.size[1]) || 0.3;
      m.position.set((Math.random() - 0.5) * 0.04, y + h / 2, 0);
      m.rotation.set(0, (Math.random() - 0.5) * 0.2, 0);
      y += h + 0.03;
    }
  }

  /* Hand over the next part, oldest first, keeping the stack tidy. Its
     world position is stamped on before it is detached — once it has no
     parent its position is local coordinates pretending to be world ones,
     and whatever animates it next would start it at the wrong end of the
     shop. */
  takeCarried() {
    const m = this.carried.shift();
    if (!m) return null;
    m.updateWorldMatrix(true, false);
    m.userData.releasedAt = m.getWorldPosition(new THREE.Vector3());
    this.carrySlot.remove(m);
    this.arrangeCarried();
    return m;
  }

  get load() { return this.carried.length; }

  /* ---------------- reach ---------------- */
  /* Two-bone CCD onto the point on the material the tool should be
     touching. The clip still supplies the character of the motion — the
     rhythm of a hacksaw, the twitch of a welder — and this only bends the
     shoulder and elbow enough that the tool lands on the work instead of
     sawing thin air half a metre to the left. */
  applyReach(dt) {
    const want = this.reachTarget && !this.clip.sit ? 1 : 0;
    this.reachW += (want - this.reachW) * Math.min(1, dt * 4.5);
    if (this.reachW < 0.02 || !this.reachTarget) return;

    this.root.updateMatrixWorld(true);
    this.j.armR.getWorldPosition(SP);
    TG.copy(this.reachTarget).sub(SP);
    const d = TG.length();
    if (d > ARM_REACH) TG.setLength(ARM_REACH);        // don't dislocate him
    TG.add(SP);

    for (const name of ['foreR', 'armR']) {
      const j = this.j[name];
      j.getWorldPosition(JP);
      this.slotR.getWorldPosition(EP);
      DA.subVectors(EP, JP);
      DB.subVectors(TG, JP);
      if (DA.lengthSq() < 1e-8 || DB.lengthSq() < 1e-8) continue;
      QQ.setFromUnitVectors(DA.normalize(), DB.normalize());
      j.getWorldQuaternion(QW);
      QW.premultiply(QQ);                               // where it should point
      j.parent.getWorldQuaternion(QP);
      QW.premultiply(QP.invert());                      // back into joint space
      j.quaternion.slerp(QW, this.reachW * 0.5);
      this.root.updateMatrixWorld(true);
    }
  }

  /* ---------------- rig ---------------- */
  seg(w, h, d, parent, y) {
    const mats = [this.matEdge, this.matEdge, this.matEdge, this.matEdge, this.matBody, this.matBody];
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mats);
    m.castShadow = true; m.receiveShadow = true;
    m.position.y = y;
    parent.add(m);
    return m;
  }
  joint(name, parent, x, y, z) {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    parent.add(g);
    this.j[name] = g;
    return g;
  }

  build() {
    const R = this.root;
    const hips = this.joint('hips', R, 0, 1.02, 0);
    this.seg(0.5, 0.26, 0.3, hips, 0);

    const torso = this.joint('torso', hips, 0, 0.13, 0);
    this.seg(0.62, 0.66, 0.36, torso, 0.33);
    // chest badge
    const badge = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.02), this.matEdge);
    badge.position.set(0, 0.42, 0.19); torso.add(badge);

    const head = this.joint('head', torso, 0, 0.78, 0);
    const hm = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5),
      [this.matEdge, this.matEdge, this.matEdge, this.matEdge, this.matFace, this.matEdge]);
    hm.position.y = 0.22; hm.castShadow = true;
    head.add(hm);
    this.headMesh = hm;
    // antenna
    const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.26, 6), this.matEdge);
    ant.position.y = 0.58; head.add(ant);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0xff7a3d, emissive: 0xff5a1a, emissiveIntensity: 1.4 }));
    bulb.position.y = 0.72; head.add(bulb);
    this.bulb = bulb;
    this.gearSlot = new THREE.Group(); head.add(this.gearSlot);

    for (const s of [1, -1]) {
      const k = s > 0 ? 'L' : 'R';
      const arm = this.joint('arm' + k, torso, s * 0.4, 0.56, 0);
      this.seg(0.17, 0.42, 0.17, arm, -0.21);
      const fore = this.joint('fore' + k, arm, 0, -0.42, 0);
      this.seg(0.15, 0.4, 0.15, fore, -0.2);
      const hand = this.joint('hand' + k, fore, 0, -0.4, 0);
      this.seg(0.17, 0.16, 0.14, hand, -0.07);
      const slot = new THREE.Group();
      slot.position.set(0, -0.13, 0.04);
      hand.add(slot);
      this['slot' + k] = slot;

      const thigh = this.joint('thigh' + k, hips, s * 0.16, -0.14, 0);
      this.seg(0.19, 0.44, 0.19, thigh, -0.22);
      const shin = this.joint('shin' + k, thigh, 0, -0.44, 0);
      this.seg(0.17, 0.42, 0.17, shin, -0.21);
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.21, 0.11, 0.34), this.matEdge);
      foot.position.set(0, -0.47, 0.07); foot.castShadow = true; shin.add(foot);
    }
  }

  /* ---------------- particles ---------------- */
  initFx() {
    this.N = 260;
    const pos = new Float32Array(this.N * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.fxMat = new THREE.PointsMaterial({
      size: 0.075, color: 0xffb347, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    this.fx = new THREE.Points(geo, this.fxMat);
    this.fx.frustumCulled = false;
    this.scene.add(this.fx);
    this.parts = Array.from({ length: this.N }, () => ({ life: 0, v: new THREE.Vector3(), p: new THREE.Vector3() }));
    this.emitAcc = 0;
  }

  emit(n, origin, kind) {
    for (let i = 0; i < this.N && n > 0; i++) {
      const p = this.parts[i];
      if (p.life > 0) continue;
      n--;
      p.p.copy(origin);
      const a = Math.random() * Math.PI * 2;
      switch (kind) {
        case 'sparks':
          p.v.set(Math.cos(a) * 3.2 * Math.random(), 1.4 + Math.random() * 2.6, Math.sin(a) * 3.2 * Math.random());
          p.life = 0.34 + Math.random() * 0.4; p.g = -9; break;
        case 'chips':
          p.v.set(Math.cos(a) * 1.2, 0.9 + Math.random() * 1.1, Math.sin(a) * 1.2);
          p.life = 0.5 + Math.random() * 0.4; p.g = -5.5; break;
        case 'dust':
          p.v.set(Math.cos(a) * 0.5, 0.35 + Math.random() * 0.4, Math.sin(a) * 0.5);
          p.life = 0.9 + Math.random(); p.g = -0.5; break;
        case 'mist':
          p.v.set(Math.cos(a) * 0.4, 0.2 + Math.random() * 0.3, Math.sin(a) * 0.4 - 0.7);
          p.life = 0.7 + Math.random() * 0.5; p.g = -0.3; break;
        case 'steam':
          p.v.set(Math.cos(a) * 0.35, 1.1 + Math.random() * 0.7, Math.sin(a) * 0.35);
          p.life = 1.1 + Math.random() * 0.6; p.g = 0.6; break;
        case 'flame':
          p.v.set(Math.cos(a) * 0.35, 1.6 + Math.random(), Math.sin(a) * 0.35);
          p.life = 0.24 + Math.random() * 0.2; p.g = 1.5; break;
        case 'drip':
          p.v.set(Math.cos(a) * 0.12, -0.15, Math.sin(a) * 0.12);
          p.life = 0.55 + Math.random() * 0.3; p.g = -3.2; break;
        default:
          p.v.set(Math.cos(a) * 0.6, 0.5, Math.sin(a) * 0.6);
          p.life = 0.5; p.g = -3;
      }
    }
  }

  stepFx(dt) {
    const arr = this.fx.geometry.attributes.position.array;
    for (let i = 0; i < this.N; i++) {
      const p = this.parts[i];
      if (p.life > 0) {
        p.life -= dt;
        p.v.y += (p.g || -9) * dt;
        p.p.addScaledVector(p.v, dt);
        if (p.p.y < 0.02) { p.p.y = 0.02; p.v.y *= -0.28; p.v.x *= 0.6; p.v.z *= 0.6; }
        arr[i * 3] = p.p.x; arr[i * 3 + 1] = p.p.y; arr[i * 3 + 2] = p.p.z;
      } else {
        arr[i * 3 + 1] = -999;
      }
    }
    this.fx.geometry.attributes.position.needsUpdate = true;
  }

  /* ---------------- props ---------------- */
  setProps(clip) {
    const set = (slot, name, key) => {
      if (this[key] === name) return;
      this[key] = name;
      slot.clear();
      if (name) { const p = makeProp(name); if (p) slot.add(p); }
    };
    set(this.slotR, clip.propR || null, '_pr');
    set(this.slotL, clip.propL || null, '_pl');

    const g = clip.gear || null;
    if (this._gear !== g) {
      this._gear = g;
      this.gearSlot.clear();
      if (g) { const o = makeHeadgear(g); if (o) this.gearSlot.add(o); }
    }
    const mood = clip.mood || 'happy';
    if (mood !== this.mood) {
      this.mood = mood;
      this.matFace.map = mood === 'focus' ? this.faceFocus : this.faceHappy;
      this.matFace.needsUpdate = true;
    }
  }

  /* ---------------- playback ---------------- */
  play(id) {
    const c = CLIP_BY_ID[id] || CLIP_BY_ID.idle;
    if (this.clip && this.clip.id === c.id) return;
    this.fromPose = this.lastPose || evalClip(this.clip, this.t);
    this.clip = c;
    this.t = 0;
    this.blend = 0;
    this.setProps(c);
  }

  update(dt) {
    this.t += dt * (this.clip.speed || 1);
    this.blend = Math.min(1, this.blend + dt / 0.22);

    let pose = evalClip(this.clip, this.t);
    if (this.blend < 1) pose = lerpPose(this.fromPose, pose, this.blend);
    this.lastPose = pose;

    for (const name of JOINTS) {
      const g = this.j[name]; if (!g) continue;
      const r = pose.rot[name] || BASE_POSE[name];
      g.rotation.set(r[0], r[1], r[2]);
    }
    this.j.hips.position.y = 1.02 + pose.y;

    // camera-shake-ish impact wobble on strike clips
    if (this.clip.shake) {
      const s = Math.max(0, Math.sin(2 * Math.PI * (this.clip.osc?.[0]?.f || 1) * this.t));
      this.root.position.y = -Math.pow(s, 8) * 0.04 * this.clip.shake;
    } else this.root.position.y = 0;

    // put the tool on the work before anything reads the hand's position
    this.applyReach(dt);

    // effects at the right hand
    this.slotR.getWorldPosition(V);
    V.y -= 0.12;
    if (this.clip.fx) {
      this.emitAcc += dt * (this.clip.fxRate || 2) * 14;
      const n = Math.floor(this.emitAcc);
      if (n > 0) { this.emit(n, V, this.clip.fx); this.emitAcc -= n; }
      const col = { sparks: 0xffc266, chips: 0xd6b184, dust: 0xd8d2c6, mist: 0x7fd0e6, steam: 0xdfeaf0, flame: 0xff9a3c, drip: 0xf0e2c0 }[this.clip.fx];
      this.fxMat.color.setHex(col || 0xffb347);
      this.fxMat.size = this.clip.fx === 'sparks' ? 0.06 : 0.1;
    }
    if (this.clip.light) {
      this.workLight.color.setHex(this.clip.light);
      this.workLight.intensity = 4 + Math.random() * 9;
      this.workLight.position.copy(this.root.worldToLocal(V.clone()));
    } else this.workLight.intensity *= 0.85;

    this.bulb.material.emissiveIntensity = 1.0 + Math.sin(this.t * 6) * 0.5;
    this.stepFx(dt);
  }

  /* ---------------- navigation ---------------- */
  faceTowards(x, z, dt, rate = 6) {
    const want = Math.atan2(x - this.root.position.x, z - this.root.position.z);
    let d = want - this.root.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.root.rotation.y += d * Math.min(1, dt * rate);
  }

  /* Returns true once arrived. */
  stepTowards(x, z, dt, speed = 2.6) {
    const dx = x - this.root.position.x, dz = z - this.root.position.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.14) return true;
    this.faceTowards(x, z, dt);
    const k = Math.min(d, speed * dt);
    this.root.position.x += (dx / d) * k;
    this.root.position.z += (dz / d) * k;
    return false;
  }

  get pos() { return this.root.position; }
}
