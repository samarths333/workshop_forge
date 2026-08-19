/* ------------------------------------------------------------------ *
 * forge.js — the shop with nobody in it
 * ------------------------------------------------------------------ *
 *
 * Bob does not want to watch a robot walk across a shop for four
 * minutes. He wants the object, a picture of it, and the files.
 *
 * So this is the whole pipeline with the theatre removed: the floor manager
 * still writes the work order, the trades still plan their own subassemblies
 * in parallel, the merge still happens, the critic still looks it over.
 * Every piece of it is the SAME code the shop uses — the same shopfloor.js,
 * the same solver, the same critic, the same exporter. Nothing here is a
 * second implementation of anything, which is the only reason it can be
 * trusted to produce what the floor would have produced. What it does not
 * do is walk anybody anywhere.
 *
 * It runs in a hidden window, because three.js needs a real GL context to
 * render a real image and Electron has one. The alternative — a
 * headless-gl or a screenshot of the visible app — is either another
 * dependency or a four-minute wait.
 */
import * as THREE from 'three';
import {
  buildMessages, parsePlan, validatePlan, offlinePlan, PLAN_SCHEMA,
  buildCritiqueMessages, applyRevision, REVISE_SCHEMA, planParts
} from './agent.js';
import { ShopFloor, jarvisReport } from './shopfloor.js';
import { attributePlan, crewTally } from './crewplan.js';
import { roleById } from './roles.js';
import { inspectPlan } from './critic.js';
import { analyse, summariseFindings } from './optimize.js';
import { describeCircuit, solveCircuit, isComponent } from './circuit.js';
import { describeEngine } from './engine.js';
import { assemblyMetrics, bom, bomCSV, formatMass, formatLen } from './metrics.js';
import {
  classifyRequest, sourcesFor, searchTerms, enrichRefs, mergeRefs, rankRefs,
  worthReading, minePages
} from './library.js';
import { partGeometry, partMaterial } from './shapes.js';
import { trianglesFrom, toSTL, toOBJ } from './export3d.js';
import { recall } from './skills.js';
import { wantsKernel, checkSolid } from './cadscript.js';
import { buildWithKernel, cadRecipe, recallScript, describeAttempts } from './cadbuild.js';

const say = m => window.forge.forgeLog(m);

/* ------------------------------------------------------------------ */
/* the build                                                           */
/* ------------------------------------------------------------------ */
async function run(request, opts) {
  say(`request: ${request}`);

  /* --- what people who make this know ---------------------------- */
  let refs = [], read = [];
  if (!opts.offline) {
    const domain = classifyRequest(request);
    const terms = searchTerms(request, domain.domain);
    try {
      const r = await window.forge.refs({ term: request, terms, sources: sourcesFor(domain.domain) });
      refs = enrichRefs(mergeRefs([rankRefs(r.refs || [], terms, request)]));
      if (refs.length) say(`${refs.length} references (${domain.label})`);
    } catch { /* a lookup never fails a build */ }

    const toRead = worthReading(refs);
    if (toRead.length) {
      try {
        const r = await window.forge.read(toRead);
        read = minePages(r.pages || [], refs);
        if (read.length) say(`read ${read.length} page(s) in full`);
      } catch { /* nor does a page fetch */ }
    }
  }

  /* --- and what Rivet already knows ------------------------------- */
  let skills = [];
  try { skills = await window.forge.skills.load(); } catch { /* first run */ }
  const recalled = recall(skills, request, { domain: classifyRequest(request).domain });
  if (recalled) say(`recalled ${recalled.skill.name} (${Math.round(recalled.skill.confidence * 100)}%)`);

  /* --- real CAD, if that is what this wants ----------------------- */
  /* A bracket with bolt holes and a fillet is not something a stack of
     primitives can be, and the robots have nothing to add to it. When
     the request is for a PART rather than an OBJECT, the kernel writes
     it properly and the shop floor sits this one out. */
  const kernelReady = opts.offline ? { ok: false } : await window.forge.cadProbe().catch(() => ({ ok: false }));
  const route = wantsKernel(request, { available: !!kernelReady.ok, forced: opts.cad ?? null });
  if (route.use) {
    say(`${route.why} — using the CAD kernel (build123d ${kernelReady.version})`);
    const cad = await buildWithKernel(request, {
      ask: async (messages, schema, who) => {
        try {
          const res = await window.forge.plan(messages, schema, who);
          if (res.ok) engineUsed = res.engine;
          return res;
        } catch (e) { say(`${who}: ${e.message}`); return { ok: false }; }
      },
      run: (code, o) => window.forge.cadRun(code, { ...o, out: opts.out, mesh: true }),
      log: say,
      recalled: recallScript(recalled),
      refs, read,
      stem: 'part'
    });

    if (cad.ok) {
      say(describeAttempts(cad));
      return { kind: 'cad', cad, engine: engineUsed, refs, read, recalled };
    }
    // the kernel could not do it, so the floor gets it after all — which
    // is the whole reason the primitive path is still here
    say(`${cad.error} — handing it back to the shop floor`);
  }

  /* --- the floor plans it ----------------------------------------- */
  /* The manager decomposes, the trades work in parallel, the merge puts it
     back together. Identical to what happens with the robots on screen —
     the only thing missing is the robots. */
  let engine = 'offline planner';
  let engineUsed = engine;
  const fallbackParts = planParts(validatePlan(offlinePlan(request, recalled), request));
  const floor = new ShopFloor({
    log: m => say(m),
    ask: async (messages, schema, who) => {
      if (opts.offline) return { ok: false };
      try {
        const res = await window.forge.plan(messages, schema, who);
        if (res.ok) { engine = res.engine; engineUsed = res.engine; }
        return res;
      } catch (e) { say(`${who}: ${e.message}`); return { ok: false }; }
    }
  });
  const { order, plan: merged, ledger } = await floor.run(request, {
    refs, read, recalled, offline: opts.offline, fallbackParts
  });

  let plan;
  try { plan = attributePlan(validatePlan(merged, request)); }
  catch (e) {
    say(`the merged plan would not validate (${e.message}) — falling back`);
    plan = attributePlan(validatePlan(offlinePlan(request, recalled), request));
  }
  const tally = crewTally(plan);
  say(`the floor: ${Object.entries(tally).filter(([, t]) => t.parts).map(([id, t]) => `${roleById(id)?.name || id} ${t.parts}`).join(', ') || 'frame only'}`);

  /* --- inspect, and revise if the model has something to say ------ */
  let report = inspectPlan(plan);
  const corrections = [...report.corrections];
  if (!opts.offline && engine !== 'offline planner') {
    try {
      const res = await window.forge.plan(
        buildCritiqueMessages(request, plan, report.issues, report.description, refs, read),
        REVISE_SCHEMA, 'critic'
      );
      if (res.ok) {
        const rev = parsePlan(res.text);
        (rev.problems || []).slice(0, 4).forEach(p => corrections.push(String(p).slice(0, 140)));
        const { changed } = applyRevision(plan, rev);
        if (changed) {
          plan = attributePlan(validatePlan(plan, plan.title));
          report = inspectPlan(plan);
          say(`revised ${changed} part(s) after inspection`);
        }
      }
    } catch { /* inspection is optional, like everything else */ }
  }

  /* --- the engineer's second look --------------------------------- */
  const findings = analyse(plan, report.solved);
  if (findings.length) say(`looked it over: ${summariseFindings(findings)}`);

  const report_ = jarvisReport({ order, ledger, plan, issues: report.issues, findings });
  say(report_);

  return {
    plan, solved: report.solved, engine, findings, corrections,
    issues: report.issues, refs, read,
    order, crew: tally, jarvis: report_,
    delegation: ledger.tasks.map(t => ({ role: t.role, status: t.status, parts: t.delivered, reason: t.reason }))
  };
}

/* ------------------------------------------------------------------ */
/* the picture                                                         */
/* ------------------------------------------------------------------ */
/* A single hero view plus the two that actually show whether the thing
   is right: front, because proportion is a lie in three-quarter, and top,
   because that is where you see what is missing. The lighting is the
   gallery's, not the shop's — this is a photograph of the finished
   object, not a still from the build. */
const VIEWS = [
  { id: 'iso',   dir: [1.05, 0.72, 1.25], label: 'three-quarter' },
  { id: 'front', dir: [0, 0.06, 1],       label: 'front' },
  { id: 'top',   dir: [0, 1, 0.001],      label: 'top' }
];

/* The kernel hands back a flat triangle soup — no parts, no materials,
   just geometry, because a B-rep solid IS one thing. So it gets its own
   scene builder rather than being bent into an instance list it is not. */
function meshScene(points) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points), 3));
  geo.computeVertexNormals();
  // the kernel works in millimetres and the viewer in metres
  geo.scale(0.001, 0.001, 0.001);
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    color: 0xb9c3cc, roughness: 0.42, metalness: 0.72, envMapIntensity: 1.1
  }));
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}

function renderViews(solved, size = 900, rawMesh = null) {
  const canvas = document.getElementById('shot');
  canvas.width = size; canvas.height = Math.round(size * 0.75);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(canvas.width, canvas.height, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14161a);

  const group = new THREE.Group();
  scene.add(group);

  if (rawMesh) group.add(meshScene(rawMesh));
  for (const inst of (rawMesh ? [] : solved.instances)) {
    const geo = partGeometry(inst.shape, inst.size);
    const mat = partMaterial(inst.material, inst.color);
    const mesh = new THREE.Mesh(geo, mat);
    const s = inst.scale || 1;
    mesh.scale.set(s, s, s);
    mesh.rotation.set(inst.rot[0], inst.rot[1], inst.rot[2]);
    mesh.position.set(inst.pos[0], inst.pos[1], inst.pos[2]);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  }

  // centre the object over the origin so every view frames it the same way
  const box = new THREE.Box3().setFromObject(group);
  const centre = box.getCenter(new THREE.Vector3());
  const span = box.getSize(new THREE.Vector3());
  const radius = Math.max(span.x, span.y, span.z) * 0.5 || 0.5;
  group.position.sub(new THREE.Vector3(centre.x, box.min.y, centre.z));

  /* A plinth, so the object is standing on something rather than
     floating in a void — the shadow is what makes it read as solid. */
  const floor = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 2.1, radius * 2.1, 0.04, 48),
    new THREE.MeshStandardMaterial({ color: 0x23272d, roughness: 0.85, metalness: 0.1 })
  );
  floor.position.y = -0.02;
  floor.receiveShadow = true;
  scene.add(floor);

  scene.add(new THREE.HemisphereLight(0xdfe8f2, 0x20242a, 0.85));
  const key = new THREE.DirectionalLight(0xfff3e0, 2.4);
  key.position.set(radius * 3, radius * 4.2, radius * 3.2);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  const d = radius * 4;
  Object.assign(key.shadow.camera, { left: -d, right: d, top: d, bottom: -d, near: 0.1, far: radius * 14 });
  key.shadow.camera.updateProjectionMatrix();
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xbcd4ff, 0.7);
  fill.position.set(-radius * 3, radius * 1.6, -radius * 2);
  scene.add(fill);

  const cam = new THREE.PerspectiveCamera(34, canvas.width / canvas.height, 0.05, 200);
  const target = new THREE.Vector3(0, span.y * 0.5, 0);
  const dist = radius * 3.9;

  const shots = [];
  for (const v of VIEWS) {
    const dir = new THREE.Vector3(...v.dir).normalize();
    cam.position.copy(target).add(dir.multiplyScalar(dist));
    cam.lookAt(target);
    cam.updateProjectionMatrix();
    renderer.render(scene, cam);
    shots.push({ id: v.id, label: v.label, data: canvas.toDataURL('image/png') });
  }

  renderer.dispose();
  return shots;
}

/* ------------------------------------------------------------------ */
/* the files                                                           */
/* ------------------------------------------------------------------ */
function exportsOf(solved) {
  /* The exporter takes triangles, not meshes, so the geometry is
     tessellated here and handed over as typed arrays — exactly what
     world.assemblyMeshes() does for the shop.

     Two things this got wrong for a long time, and neither of them threw
     anywhere a person would see it: trianglesFrom takes ONE mesh, not a
     list, and toSTL/toOBJ want `{name, tris}` rather than the raw geometry
     arrays. Handed the wrong shape it read `position.length` off undefined
     and every headless build died on its last step, after doing all the
     work. The shop's own exportGroups() has always done it correctly — this
     now does the same thing, in the same order. */
  const groups = [];
  const seen = new Map();
  for (const inst of solved.instances) {
    const geo = partGeometry(inst.shape, inst.size);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
    const s = inst.scale || 1;
    mesh.scale.set(s, s, s);
    mesh.rotation.set(inst.rot[0], inst.rot[1], inst.rot[2]);
    mesh.position.set(inst.pos[0], inst.pos[1], inst.pos[2]);
    mesh.updateMatrixWorld(true);

    const pos = geo.getAttribute('position');
    const tris = trianglesFrom({
      position: pos.array,
      index: geo.index ? geo.index.array : null,
      matrix: mesh.matrixWorld.elements
    });
    geo.dispose();
    if (!tris.length) continue;

    // two parts called "leg" must not become one object called "leg"
    const base = inst.name || inst.shape;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    groups.push({ name: n > 1 ? `${base}_${n}` : base, tris });
  }

  return { stl: toSTL(groups), obj: toOBJ(groups) };
}

/* ------------------------------------------------------------------ */
/* what Bob gets back                                                  */
/* ------------------------------------------------------------------ */
window.addEventListener('DOMContentLoaded', async () => {
  const opts = await window.forge.forgeJob();
  try {
    const built = await run(opts.request, opts);

    /* The kernel route produces a solid, not an assembly, so it reports
       what a solid has — volume, faces, a STEP file — and skips
       everything that only means something for a stack of parts. */
    if (built.kind === 'cad') {
      const c = built.cad, m = c.metrics;
      const shots = renderViews(null, opts.size || 900, c.mesh);
      window.forge.forgeDone({
        ok: true,
        request: opts.request,
        title: opts.request,
        via: 'cad',
        summary: `${opts.request} — one solid, `
          + `${m.size.map(v => Math.round(v)).join(' × ')}mm, `
          + `${Math.round(m.volume)}mm³, ${m.faces} faces`,
        note: describeAttempts(c),
        engine: built.engine,
        shots,
        script: c.script,
        kernelFiles: c.files,          // main copies these next to the pictures
        metrics: {
          parts: 1, operations: c.attempts,
          size_mm: m.size.map(v => Math.round(v)),
          volume_mm3: Math.round(m.volume),
          faces: m.faces, edges: m.edges, solids: m.solids,
          stable: true
        },
        findings: c.findings.map(f => ({ kind: f.kind, severity: f.severity, title: f.title, why: f.why, gain: f.gain })),
        steps: []
      });
      return;
    }

    const { plan, solved, findings } = built;

    const parts = planParts(plan);
    const m = assemblyMetrics(solved);
    const shots = renderViews(solved, opts.size || 900);
    const files = exportsOf(solved);
    const circuit = plan.wires?.length ? describeCircuit(parts, plan.wires) : '';
    /* The numbers, for the program on the other end of the pipe — it asked
       for an engine, so what it wants back is the engine's numbers. NOT
       called `engine`: that key already means which model answered, and
       two keys of the same name in one object literal is one key. */
    const powerplant = plan.engine ? describeEngine(plan) : '';

    /* A sentence a person would say, because Bob is going to read this
       out loud and "7 instances, tipRatio 0.42" is not a sentence. */
    const summary = [
      `${plan.title} — ${solved.instances.length} part${solved.instances.length === 1 ? '' : 's'}`,
      `${formatLen(m.size[0], 'mm')} × ${formatLen(m.size[1], 'mm')} × ${formatLen(m.size[2], 'mm')}`,
      formatMass(m.mass),
      m.stable ? 'stands up' : 'it topples — the mass is outside the base'
    ].join(', ');

    window.forge.forgeDone({
      ok: true,
      request: opts.request,
      title: plan.title,
      summary,
      engine: built.engine,
      note: plan.summary,
      shots,
      stl: files.stl,
      obj: files.obj,
      plan,
      bom: bomCSV(bom(solved, parts), { unit: 'mm' }),
      metrics: {
        parts: solved.instances.length,
        operations: plan.steps.length,
        size_mm: m.size.map(v => Math.round(v * 1000)),
        mass_kg: Math.round(m.mass * 1000) / 1000,
        stable: m.stable,
        joints: solved.joints.length
      },
      circuit,
      powerplant,
      engineSpec: plan.engine || null,
      findings: findings.map(f => ({
        kind: f.kind, severity: f.severity, title: f.title, why: f.why, gain: f.gain
      })),
      /* Who built what. Bob asked for the object, but when it comes back
         wrong the first useful question is which trade got it wrong, and
         that is not answerable from a parts list. */
      jarvis: built.jarvis,
      crew: built.crew,
      delegation: built.delegation,
      workorder: built.order && {
        frame: built.order.frame.map(f => f.name),
        mounts: built.order.mounts.map(m => m.id),
        requirements: built.order.requirements
      },
      steps: plan.steps.map(s => ({ room: s.room, action: s.action, say: s.say, by: s.by }))
    });
  } catch (err) {
    window.forge.forgeDone({ ok: false, error: err.message, stack: String(err.stack || '').slice(0, 800) });
  }
});
