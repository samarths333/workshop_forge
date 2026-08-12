import * as THREE from 'three';
import { World, ROOMS, ROOM_ORDER, PEDESTAL_Z } from './world.js';
import { Rivet } from './character.js';
import { CLIP_BY_ID, CLIPS } from './animations.js';
import {
  buildMessages, parsePlan, validatePlan, offlinePlan, PLAN_SCHEMA,
  buildCritiqueMessages, applyRevision, REVISE_SCHEMA,
  buildReflectMessages, REFLECT_SCHEMA,
  planParts, editPart, addPart, removePart
} from './agent.js';
import { inspectPlan, describeSolved } from './critic.js';
import { recall, learn, sanitize, mergeLibraries, deterministicReflection, repeatedFault, describeEdits } from './skills.js';
import { CadView } from './cad.js';
import { History } from './history.js';
import { trianglesFrom, toSTL, toOBJ, summarise } from './export3d.js';
import { assemblyMetrics, bom, bomCSV, formatLen, formatMass, formatVolume } from './metrics.js';
import { SOURCES, classifyRequest, sourcesFor, searchTerms, enrichRefs, mergeRefs, domainKnowledge } from './library.js';

const $ = s => document.querySelector(s);
const stage = $('#stage');
const world = new World($('#cv'));
const rivet = new Rivet(world.scene);
rivet.root.position.set(ROOMS.cardboard.x, 0, 1.5);

/* how many parts he can get his arms around in one trip */
const ARMFUL = 4;

/* ------------------------------------------------------------------ */
/* logging                                                             */
/* ------------------------------------------------------------------ */
const logEl = $('#log');
function log(msg, cls = '') {
  const d = document.createElement('div');
  d.className = 'l ' + cls;
  const t = new Date().toLocaleTimeString('en-GB', { hour12: false });
  d.innerHTML = `<span class="t">${t}</span>  ${msg}`;
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
  while (logEl.children.length > 220) logEl.removeChild(logEl.firstChild);
}

/* ------------------------------------------------------------------ */
/* executor                                                            */
/* ------------------------------------------------------------------ */
const job = {
  plan: null, solved: null, request: '', engine: '', cls: 'offline',
  i: -1, phase: 'idle', t: 0, running: false,
  parts: 0, placed: 0, idleTimer: 0, wp: null,
  instByPart: new Map(), haul: null,
  recalled: null, corrections: [], clean: true, learned: false,
  reflection: null, asPlanned: null, edited: false, refs: []
};

/* true once every part is on the pedestal and nothing is mid-flight —
   which is when a CAD edit can safely re-place the whole assembly */
const buildSettled = () => !!job.plan && !job.running && job.placed > 0;

const IDLE_LOOP = ['idle', 'idle_look', 'think', 'sip_coffee', 'dust_off', 'stretch', 'scratch_head'];

function stationFor(step) {
  const r = ROOMS[step.room];
  const clip = CLIP_BY_ID[step.action];
  if (clip.sit && r.seat) return { x: r.seat[0], z: r.seat[1] };
  // close enough that the tool can reach the material once the arm solves
  return { x: r.bench[0], z: r.bench[1] + 0.95 };
}

function startJob(plan, solved) {
  job.plan = plan; job.solved = solved;
  job.i = -1; job.phase = 'next'; job.t = 0;
  job.running = true; job.parts = 0; job.placed = 0;
  job.haul = null; job.learned = false;
  world.releaseWork(job.wp, false); job.wp = null;
  world.clearAssembly();
  rivet.carried.length && rivet.carried.splice(0).forEach(m => rivet.carrySlot.remove(m));

  job.instByPart = new Map();
  for (const inst of solved.instances) {
    if (!job.instByPart.has(inst.src)) job.instByPart.set(inst.src, []);
    job.instByPart.get(inst.src).push(inst);
  }

  renderTraveler();
  pushToCad();
  if (cad.active) cad.frameAll();
  // a new job is the floor of the undo stack — you cannot step back out of
  // this build and into the last one
  history.reset({ steps: plan.steps }, 'as planned');
  syncUndo();
  $('#btnStop').disabled = false;
  $('#btnBuild').disabled = true;
  $('#btnExport').disabled = false;
  setModelExport(false);
  log(`job on the floor: <b>${esc(plan.title)}</b> — ${plan.steps.length} operations, ${solved.instances.length} components`, 'hi');
}

function stopJob(reason) {
  job.running = false; job.phase = 'idle'; job.haul = null;
  job.plan && renderTraveler();
  world.releaseWork(job.wp, false); job.wp = null;
  rivet.reachTarget = null;
  renderProgress(0);
  $('#btnStop').disabled = true;
  $('#btnBuild').disabled = false;
  rivet.play('idle');
  if (reason) log(reason, 'err');
}

function advance() {
  job.i++;
  if (job.i >= job.plan.steps.length) {
    // anything still on a rack gets carried over before he takes a bow
    if (world.stagedRooms().length || rivet.load) { beginHaul('wrap'); return; }
    finishJob();
    return;
  }
  const step = job.plan.steps[job.i];
  // the gallery is where parts come together, so the parts have to be there
  if (step.room === 'finished' && (world.stagedRooms().length || rivet.load)) {
    beginHaul('step');
    return;
  }
  job.phase = 'walk'; job.t = 0;
  renderTraveler();
  world.lookAtRoom(step.room);
}

function finishJob() {
  const seams = world.buildSeams(job.solved.joints);
  log(`job complete — ${job.placed} component${job.placed === 1 ? '' : 's'} on the pedestal${seams ? `, ${seams} joint${seams === 1 ? '' : 's'} made good` : ''}`, 'ok');
  rivet.play('celebrate');
  rivet.reachTarget = null;
  job.phase = 'wrap'; job.t = 0;
  job.running = false;
  $('#btnStop').disabled = true;
  $('#btnBuild').disabled = false;
  setModelExport(true);
  renderTraveler();
  pushToCad();
  reflectAndLearn();
}

/* ------------------------------------------------------------------ */
/* the haul — nothing teleports, he carries it                         */
/* ------------------------------------------------------------------ */
function beginHaul(then) {
  job.phase = 'haul';
  job.haul = { stage: rivet.load ? 'carry' : 'goto', t: 0, room: null, then, trips: 0 };
  caption('fetching the parts', 'These do not walk over by themselves.');
}

function haulTick(dt) {
  const h = job.haul;
  h.t += dt;

  if (h.stage === 'goto') {
    const rooms = world.stagedRooms();
    if (!rooms.length) { endHaul(); return; }
    // nearest rack first, so he isn't crossing the shop twice for one panel
    rooms.sort((a, b) => Math.abs(a.x - rivet.pos.x) - Math.abs(b.x - rivet.pos.x));
    h.room = rooms[0].room;
    const rack = world.racks[h.room];
    world.lookAtRoom(h.room);
    const far = Math.abs(rivet.pos.x - rack.x) > 6;
    rivet.play(far ? 'run' : 'walk');
    caption(far ? 'crossing the shop' : 'walking', `Going for the ${h.room} parts.`);
    if (rivet.stepTowards(rack.x, rack.z + 1.15, dt, far ? 5.4 : 3.2)) { h.stage = 'lift'; h.t = 0; }
    return;
  }

  if (h.stage === 'lift') {
    const rack = world.racks[h.room];
    rivet.faceTowards(rack.x, rack.z, dt, 6);
    rivet.play('pick_up');
    if (h.t === dt || h.t < 0.05) caption('lifting', 'Getting my arms around it.');
    if (h.t > 1.1) {
      const room = h.room;
      const take = world.takeStaged(room, ARMFUL - rivet.load);
      for (const m of take) rivet.carry(m);
      log(`  ↳ picked up ${take.length} part${take.length === 1 ? '' : 's'} from the ${room} rack`);
      // top the load up from another rack on the way past, if he has room
      h.stage = (rivet.load < ARMFUL && world.stagedRooms().length) ? 'goto' : 'carry';
      h.t = 0;
    }
    return;
  }

  if (h.stage === 'carry') {
    if (!rivet.load) { h.stage = 'goto'; return; }
    world.lookAtRoom('finished');
    const tx = ROOMS.finished.x, tz = PEDESTAL_Z + 1.15;
    const far = Math.abs(rivet.pos.x - tx) > 6;
    rivet.play('walk_carry');
    caption('hauling it over', `Carrying ${rivet.load} part${rivet.load === 1 ? '' : 's'} to the gallery.`);
    if (rivet.stepTowards(tx, tz, dt, far ? 3.6 : 2.6)) { h.stage = 'place'; h.t = 0; h.trips++; }
    return;
  }

  if (h.stage === 'place') {
    rivet.faceTowards(ROOMS.finished.x, PEDESTAL_Z, dt, 6);
    rivet.play('set_down');
    if (h.t > 0.55) {
      h.t = 0;
      const mesh = rivet.takeCarried();
      if (mesh) placePart(mesh);
      if (!rivet.load) {
        rivet.reachTarget = null;
        h.stage = world.stagedRooms().length ? 'goto' : 'done';
      }
    }
    return;
  }

  if (h.stage === 'done') endHaul();
}

function endHaul() {
  rivet.reachTarget = null;
  job.haul = null;
  if (job.plan && job.i >= job.plan.steps.length) { finishJob(); return; }
  job.phase = 'walk'; job.t = 0;
  renderTraveler();
  if (job.plan && job.i >= 0) world.lookAtRoom(job.plan.steps[job.i].room);
}

/* One carried part goes down where the solver said it belongs. If the part
   was arrayed — four legs, three fins — he sets down the one he is holding
   and the rest of the batch go with it. */
function placePart(mesh) {
  const src = mesh.userData.partIndex;
  const insts = job.instByPart.get(src) || [];
  if (!insts.length) { world.scene.remove(mesh); return; }

  // where it was in his hands the instant he let go of it
  const from = mesh.userData.releasedAt || mesh.getWorldPosition(new THREE.Vector3());
  world.placeInstance(mesh, insts[0], from);
  reachAt(insts[0]);
  // the rest of the same batch — four legs cut in one operation go down as
  // four legs, out of the same armful
  for (let k = 1; k < insts.length; k++) {
    world.placeInstance(world.cloneForInstance(mesh), insts[k], from);
  }
  job.placed += insts.length;
  const label = mesh.userData.spec?.name || 'part';
  log(`  ↳ set <b>${esc(label)}</b>${insts.length > 1 ? ` ×${insts.length}` : ''} on the pedestal`, 'ok');
  $('#jobParts').textContent = `${job.placed} placed`;
}

function reachAt(inst) {
  const v = new THREE.Vector3(inst.pos[0], inst.pos[1], inst.pos[2]);
  world.assembly.localToWorld(v);
  rivet.reachTarget = v;
}

/* ------------------------------------------------------------------ */
/* per-step machine                                                    */
/* ------------------------------------------------------------------ */
function stepTick(dt) {
  if (job.phase === 'next') { advance(); return; }
  if (job.phase === 'haul') { haulTick(dt); return; }
  if (!job.plan || job.i < 0 || job.i >= job.plan.steps.length) return;
  const step = job.plan.steps[job.i];
  const st = stationFor(step);

  if (job.phase === 'walk') {
    const far = Math.abs(rivet.pos.x - st.x) > 6;
    rivet.play(far ? 'run' : 'walk');
    rivet.reachTarget = null;
    caption(far ? 'crossing the shop' : 'walking', '');
    if (rivet.stepTowards(st.x, st.z, dt, far ? 5.4 : 3.2)) {
      job.phase = 'work'; job.t = 0;
      rivet.play(step.action);
      caption(CLIP_BY_ID[step.action].label, step.say);
      log(`<b>${step.room}</b> · ${step.action} — ${esc(step.say)}`);
      // material goes down on the bench first, so the tool has something to meet
      job.wp = world.beginWork(step, step.room);
      rivet.reachTarget = job.wp ? job.wp.contact : null;
    }
    return;
  }

  if (job.phase === 'work') {
    const b = ROOMS[step.room].bench;
    rivet.faceTowards(b[0], b[1], dt, 5);
    job.t += dt;
    world.updateWork(job.wp, Math.min(1, job.t / step.seconds), T);
    renderProgress(job.t / step.seconds);
    if (job.t >= step.seconds) {
      const mesh = world.releaseWork(job.wp, !!step.part);
      job.wp = null;
      rivet.reachTarget = null;
      if (mesh) {
        mesh.userData.partIndex = job.parts;
        world.stagePart(mesh, step.room);
        job.parts++;
        const n = (job.instByPart.get(mesh.userData.partIndex) || []).length;
        log(`  ↳ made <b>${esc(step.part.name)}</b>${n > 1 ? ` ×${n}` : ''} (${step.part.shape}, ${step.part.material}) — on the rack`, 'ok');
      }
      job.phase = 'next';
    }
    return;
  }

  if (job.phase === 'wrap') {
    job.t += dt;
    rivet.faceTowards(ROOMS.finished.x, PEDESTAL_Z, dt, 3);
    if (job.t > 1.6) { rivet.play('present'); caption('presenting', job.plan.summary || 'Done.'); }
    if (job.t > 5) { job.phase = 'idle'; }
  }
}

function idleTick(dt) {
  job.idleTimer -= dt;
  if (job.idleTimer <= 0) {
    job.idleTimer = 5 + Math.random() * 7;
    const pick = IDLE_LOOP[Math.floor(Math.random() * IDLE_LOOP.length)];
    rivet.play(pick);
    caption(CLIP_BY_ID[pick].label, '');
  }
}

function caption(act, say) {
  $('#capAct').textContent = act;
  $('#capSay').textContent = say || '';
}

function renderProgress(k) {
  const bar = $('#capBar');
  if (bar) bar.style.width = `${Math.max(0, Math.min(1, k)) * 100}%`;
  const now = $('#steps .now .sBar span');
  if (now) now.style.width = `${Math.max(0, Math.min(1, k)) * 100}%`;
}

/* ------------------------------------------------------------------ */
/* traveler ticket                                                     */
/* ------------------------------------------------------------------ */
function renderTraveler() {
  const p = job.plan;
  $('#jobTitle').textContent = p ? p.title : '— no job on the floor —';
  $('#jobSummary').textContent = p ? p.summary : 'Give Rivet a build request and the steps land here, stamped off as he finishes each one.';
  const ol = $('#steps'); ol.innerHTML = '';
  if (!p) { $('#jobCount').textContent = '0 / 0 operations'; $('#jobParts').textContent = '0 parts'; return; }
  p.steps.forEach((s, i) => {
    const li = document.createElement('li');
    li.className = i < job.i ? 'done' : (i === job.i ? 'now' : '');
    const n = s.part ? (job.instByPart.get(partIndexOf(p, i)) || []).length : 0;
    li.innerHTML =
      `<span class="n">${String(i + 1).padStart(2, '0')}</span><div>
       <div class="sSay">${esc(s.say)}</div>
       <div class="sMeta">${s.room} · ${s.action.replace(/_/g, ' ')} · ${s.seconds}s</div>
       ${s.part ? `<span class="sPart">${esc(s.part.name)}${n > 1 ? ` ×${n}` : ''} — ${s.part.shape}/${s.part.material}</span>` : ''}
       ${i === job.i ? '<div class="sBar"><span></span></div>' : ''}
     </div>`;
    ol.appendChild(li);
  });
  $('#jobCount').textContent = `${Math.max(0, Math.min(job.i, p.steps.length))} / ${p.steps.length} operations`;
  $('#jobParts').textContent = job.placed ? `${job.placed} placed` : `${job.parts} made`;
  const now = ol.querySelector('.now');
  if (now) now.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function partIndexOf(plan, stepIndex) {
  let n = 0;
  for (let i = 0; i < stepIndex; i++) if (plan.steps[i].part) n++;
  return n;
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ------------------------------------------------------------------ */
/* the skill library                                                   */
/* ------------------------------------------------------------------ */
let skills = [];

async function loadSkills() {
  try { skills = sanitize(await window.forge.skills.load()); }
  catch { skills = []; }
  renderSkills();
}

async function persistSkills() {
  try { await window.forge.skills.save(skills); }
  catch (e) { log('could not write the skill library: ' + e.message, 'err'); }
}

function renderSkills() {
  const wrap = $('#skills');
  const count = $('#skillCount');
  wrap.innerHTML = '';
  count.textContent = skills.length ? `${skills.length} learned` : 'nothing yet';
  if (!skills.length) {
    wrap.innerHTML = '<p class="fine empty">Nothing yet. Every finished build leaves one behind — what the thing was made of, and what inspection had to correct. The next request that looks like it starts from here instead of from scratch.</p>';
    return;
  }
  for (const s of skills) {
    const el = document.createElement('div');
    el.className = 'skill';
    const pct = Math.round((s.confidence || 0) * 100);
    el.innerHTML =
      `<div class="sk-head">
         <span class="sk-name">${esc(s.name)}</span>
         ${s.stats.taught ? '<span class="sk-taught" title="corrected by hand on the bench">✋</span>' : ''}
         <span class="sk-class">${esc(s.class)}</span>
         <button class="sk-again" title="build this again">↻</button>
         <button class="sk-forget" title="forget this">✕</button>
       </div>
       <div class="sk-bar"><span style="width:${pct}%"></span></div>
       <div class="sk-meta">${s.stats.uses} build${s.stats.uses === 1 ? '' : 's'} · ${s.stats.cleanFirstPass} clean${s.stats.taught ? ` · ${s.stats.taught} taught` : ''} · ${(s.recipe.parts || []).length} parts · ${pct}% sure</div>
       ${(s.lessons || []).length ? `<ul class="sk-lessons">${s.lessons.slice(0, 3).map(l => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}`;
    /* Build it again. The request that produced it goes back in the box —
       which is what makes the recall fire, so this is a real rebuild off
       the stored recipe rather than a replay of a recording. */
    el.querySelector('.sk-again').onclick = () => {
      if (job.running) { log('he is already on a job', 'err'); return; }
      const req = (s.sourceRequests || [])[0] || s.name;
      $('#req').value = req;
      log(`building <b>${esc(s.name)}</b> again — "${esc(req)}"`, 'hi');
      requestBuild();
    };
    el.querySelector('.sk-forget').onclick = async () => {
      skills = skills.filter(x => x !== s);
      await persistSkills();
      renderSkills();
      log(`forgot how to build <b>${esc(s.name)}</b>`, 'err');
    };
    wrap.appendChild(el);
  }
}

/* Everything that comes off the floor at the end of a build. Runs in the
   background — Rivet is already taking his bow. */
async function reflectAndLearn() {
  if (job.learned || !job.plan || !job.solved) return;
  job.learned = true;

  const description = describeSolved(job.solved);
  let reflection = null;

  if (job.cls !== 'offline') {
    try {
      const res = await window.forge.plan(
        buildReflectMessages(job.request, job.plan, description, job.corrections),
        REFLECT_SCHEMA
      );
      if (res.ok) reflection = parsePlan(res.text);
    } catch (err) {
      log('reflection failed: ' + err.message, 'err');
    }
  }
  if (!reflection || !reflection.object_class) {
    reflection = deterministicReflection(job.request, job.plan, job.solved, job.corrections);
  }
  // kept so a later hand-correction on the bench can be filed under the same
  // class, with the diff against what actually came off the floor
  job.reflection = reflection;
  if (!job.asPlanned) job.asPlanned = structuredClone(planParts(job.plan));

  const prior = job.recalled?.skill;
  const again = repeatedFault(prior, job.corrections);
  const { skills: next, skill, isNew } = learn(skills, {
    request: job.request, plan: job.plan, solved: job.solved,
    reflection, corrections: job.corrections, clean: job.clean
  });
  skills = next;
  await persistSkills();
  renderSkills();

  if (isNew) log(`learned a new skill: <b>${esc(skill.name)}</b> (class ${esc(skill.class)})`, 'hi');
  else log(`updated what he knows about <b>${esc(skill.class)}</b> — ${skill.stats.uses} builds, ${Math.round(skill.confidence * 100)}% sure`, 'hi');
  (skill.lessons || []).slice(0, 2).forEach(l => log('  keeps: ' + esc(l)));
  if (again) log('  same fault as last time — the lesson on file is not landing', 'err');
}

/* ------------------------------------------------------------------ */
/* planning                                                            */
/* ------------------------------------------------------------------ */
function setEngine(text, cls) {
  const e = $('#engine');
  e.textContent = text;
  e.className = 'badge ' + cls;
}

async function requestBuild() {
  const text = $('#req').value.trim();
  if (!text) return;
  $('#btnBuild').disabled = true;
  setEngine('thinking…', 'busy');
  rivet.play('think');
  rivet.reachTarget = null;
  caption('thinking it through', 'Working out the order of operations.');
  log(`request: "${esc(text)}"`);

  job.request = text;
  job.corrections = [];
  job.clean = true;
  job.reflection = null;
  job.asPlanned = null;
  job.edited = false;
  job.refs = [];
  $('#cadTeachNote').textContent = 'Corrections here become the recipe he starts from next time.';

  /* Go and look at how people actually make this before deciding how to
     make it. Never allowed to fail the build — if nothing comes back, the
     planner just works from the request the way it always did. */
  /* Where to look depends on what was asked for. A phone stand has a
     hundred good models published; a turbofan has none, and asking a print
     site for one wastes the lookup entirely. */
  const domain = classifyRequest(text);
  job.domain = domain;
  const sources = sourcesFor(domain.domain);
  if (domain.engineering) {
    log(`that is ${esc(domain.label)} — going to ${sources.map(s => SOURCES[s]?.label || s).join(', ')} instead of the print sites`, 'hi');
  }

  let refs = [];
  try {
    const r = await window.forge.refs({ term: text, terms: searchTerms(text, domain.domain), sources });
    refs = enrichRefs(mergeRefs([r.refs || []]));
    if (refs.length) {
      const bySource = refs.reduce((m, x) => (m[x.source] = (m[x.source] || 0) + 1, m), {});
      log(`looked up ${refs.length} reference${refs.length === 1 ? '' : 's'} — ${Object.entries(bySource).map(([k, v]) => `${v} on ${SOURCES[k]?.label || k}`).join(', ')}`, 'hi');
      refs.slice(0, 3).forEach(x => log(`  ref: ${esc(x.title)}${x.structure?.length ? ` — names ${esc(x.structure.slice(0, 4).join(', '))}` : ''}`));
    } else if (!r.off) {
      (r.tried || []).forEach(t => log('references: ' + esc(t), 'err'));
    }
    // even with nothing back, an engineering request still gets the
    // built-in vocabulary for its domain — that is the point of having one
    if (!refs.length && domain.engineering) {
      const k = domainKnowledge(domain.domain);
      if (k) log(`nothing came back — building from what the shop knows a ${esc(domain.label)} is made of: ${esc(k.parts.slice(0, 5).join(', '))}…`, 'hi');
    }
  } catch (err) {
    log('reference lookup skipped: ' + esc(err.message), 'err');
  }
  job.refs = refs;
  setRefBadge(refs);

  const recalled = recall(skills, text);
  job.recalled = recalled;
  if (recalled) {
    log(`recalled <b>${esc(recalled.skill.name)}</b> — built ${recalled.skill.stats.uses}×, matched on ${recalled.matched.map(esc).join(', ')}`, 'hi');
    setRecallBadge(recalled);
  } else {
    setRecallBadge(null);
  }

  let plan = null, engine = 'offline planner', cls = 'offline';
  try {
    const res = await window.forge.plan(buildMessages(text, recalled, refs), PLAN_SCHEMA);
    if (res.ok) {
      plan = validatePlan(parsePlan(res.text), text);
      engine = res.engine;
      cls = /NIM/i.test(res.engine) ? 'nim' : 'ollama';
      if (res.tried?.length) res.tried.forEach(t => log('fallback: ' + esc(t), 'err'));
    } else {
      (res.tried || []).forEach(t => log('fallback: ' + esc(t), 'err'));
    }
  } catch (err) {
    log('plan rejected: ' + esc(err.message), 'err');
  }

  if (!plan) {
    plan = validatePlan(offlinePlan(text, recalled), text);
    log(recalled ? 'no engine reachable — building it from the recipe he already knows' : 'using the built-in keyword planner', 'err');
    rivet.play(recalled ? 'thumbs_up' : 'shrug');
  }

  job.engine = engine; job.cls = cls;
  setEngine(engine, cls);

  const { plan: finalPlan, solved } = await reviewBuild(text, plan, cls, refs);
  setEngine(engine, cls);
  startJob(finalPlan, solved);
}

/* Rivet checks his own work before he starts cutting. The solver runs
   first and always — it is local, and it turns the plan into the real
   assembly. Then, if a model is reachable, it gets asked the only question
   arithmetic cannot answer: does this read as the thing that was ordered. */
async function reviewBuild(request, plan, cls, refs) {
  rivet.play('inspect');
  caption('checking the drawing', 'Making sure this reads as the thing you asked for.');

  let report = inspectPlan(plan);
  report.corrections.forEach(c => { log('  solver: ' + esc(c), 'ok'); job.corrections.push(c); });
  report.issues.forEach(p => log('  check: ' + esc(p), 'err'));
  if (report.corrections.length || report.issues.length) job.clean = false;

  if (cls === 'offline') {
    if (!report.issues.length) log('geometry checks out', 'ok');
    return { plan, solved: report.solved };
  }

  try {
    const res = await window.forge.plan(
      buildCritiqueMessages(request, plan, report.issues, report.description, refs),
      REVISE_SCHEMA
    );
    if (!res.ok) { log('self-check skipped — no engine answered', 'err'); return { plan, solved: report.solved }; }

    const rev = parsePlan(res.text);
    log(`reads as: <b>${esc(String(rev.reads_as || '?').slice(0, 90))}</b>`);

    if (rev.verdict === 'good' && !report.issues.length) {
      log('self-check passed — building it', 'ok');
      return { plan, solved: report.solved };
    }
    job.clean = false;
    (rev.problems || []).slice(0, 6).forEach(p => {
      const s = String(p).slice(0, 140);
      log('  fault: ' + esc(s), 'err');
      job.corrections.push(s);
    });

    const { changed } = applyRevision(plan, rev);
    if (!changed) { log('nothing to change', 'ok'); return { plan, solved: report.solved }; }

    const fixed = validatePlan(plan, plan.title);
    const after = inspectPlan(fixed);
    log(`revised ${changed} part${changed === 1 ? '' : 's'} — ${after.issues.length
      ? after.issues.length + ' issue(s) still open'
      : 'geometry now clean'}`, after.issues.length ? 'err' : 'ok');
    return { plan: fixed, solved: after.solved };
  } catch (err) {
    log('self-check failed: ' + esc(err.message), 'err');
    return { plan, solved: report.solved };
  }
}

function setRefBadge(refs) {
  const b = $('#refs');
  if (!refs || !refs.length) { b.hidden = true; return; }
  b.hidden = false;
  const top = refs[0];
  b.textContent = `${refs.length} refs · ${top.source}`;
  b.title = refs.map(r => `${r.title}  [${r.source}]`).join('\n');
  b.onclick = () => { if (top.url) window.forge.openUrl(top.url); };
}

function setRecallBadge(recalled) {
  const b = $('#recall');
  if (!recalled) { b.hidden = true; return; }
  b.hidden = false;
  b.textContent = `recalling: ${recalled.skill.name} · ${Math.round(recalled.skill.confidence * 100)}%`;
}

/* ------------------------------------------------------------------ */
/* the bench — CAD workspace                                           */
/* ------------------------------------------------------------------ */
const cad = new CadView({
  renderer: world.renderer,
  tex: world.tex,
  env: world.envMap,
  dom: { root: $('#cad'), tree: $('#cadTree'), side: $('#cadSide'), stats: $('#cadStats') }
});

function openCad() {
  if (!cad.active) {
    cad.active = true;
    $('#cad').hidden = false;
    document.body.classList.add('cadOn');
    $('#btnCad').classList.add('on');
    pushToCad();
    resize();
    cad.frameAll();
  }
}
function closeCad() {
  cad.active = false;
  $('#cad').hidden = true;
  document.body.classList.remove('cadOn');
  $('#btnCad').classList.remove('on');
}
const toggleCad = () => (cad.active ? closeCad() : openCad());
$('#btnCad').onclick = toggleCad;

/* Hand the current plan to the bench. Called after planning, after every
   edit, and when the panel opens. */
function pushToCad() {
  if (!job.plan || !job.solved) { cad.setModel(null, [], null); return; }
  cad.setModel(job.plan, planParts(job.plan), job.solved);
}

/* ---- undo ---- */
/* Whole plans, not diffs. A plan is a few kilobytes of JSON and a re-solve
   costs more than a clone, so there is nothing to be gained by being clever
   here — and an inverse operation that applies backwards slightly wrong is
   a much worse bug than a stack that is a little fat. */
const history = new History();

function snapshot(label, key) {
  if (!job.plan) return;
  history.push({ steps: job.plan.steps }, { label, key });
  syncUndo();
}

function syncUndo() {
  const u = $('#btnUndo'), r = $('#btnRedo');
  if (!u || !r) return;
  u.disabled = !history.canUndo;
  r.disabled = !history.canRedo;
  u.title = history.canUndo ? `⌘Z — undo ${history.undoLabel}` : '⌘Z';
  r.title = history.canRedo ? `⇧⌘Z — redo ${history.redoLabel}` : '⇧⌘Z';
}

function applyHistory(state, verb) {
  if (!state || !job.plan) return;
  job.plan.steps = structuredClone(state.steps);
  // the selection can easily point past the end of a shorter plan
  const n = planParts(job.plan).length;
  if (cad.selected != null && cad.selected >= n) cad.selected = n ? n - 1 : null;
  reSolve();
  syncUndo();
  log(`${verb} on the bench`, 'hi');
}

const undoEdit = () => history.canUndo && applyHistory(history.undo(), 'stepped back');
const redoEdit = () => history.canRedo && applyHistory(history.redo(), 'stepped forward');

/* One field changed in the properties panel: mutate the spec, record it,
   re-solve, and put the result on the bench — and on the pedestal too if
   the build has already finished, so the two views never disagree. */
cad.onEdit = (index, patch) => {
  if (!job.plan) return;
  if (!job.asPlanned) job.asPlanned = structuredClone(planParts(job.plan));
  const field = Object.keys(patch)[0] || 'field';
  editPart(job.plan, index, patch);
  // keystrokes in one field are one edit, not four
  snapshot(`${field} on ${planParts(job.plan)[index]?.name || 'a part'}`, `edit:${index}:${field}`);
  reSolve();
};

cad.onCommand = (cmd) => {
  if (cmd === 'undo') return undoEdit();
  if (cmd === 'redo') return redoEdit();
  if (!job.plan) return;
  if (!job.asPlanned) job.asPlanned = structuredClone(planParts(job.plan));

  if (cmd === 'add') {
    const { index } = addPart(job.plan, { name: 'new part', shape: 'box', material: 'metal' });
    snapshot('an added part');
    reSolve();
    cad.select(index);
    log('added a part on the bench', 'hi');
  } else if (cmd === 'delete') {
    if (cad.selected == null) return;
    const gone = planParts(job.plan)[cad.selected];
    removePart(job.plan, cad.selected);
    cad.selected = null;
    snapshot(`scrapping the ${gone?.name || 'part'}`);
    reSolve();
    log(`scrapped <b>${esc(gone?.name || 'a part')}</b> on the bench`, 'err');
  } else if (cmd === 'teach') {
    teachFromBench();
  }
};

function reSolve() {
  const report = inspectPlan(job.plan);
  job.solved = report.solved;
  job.edited = true;
  job.instByPart = new Map();
  for (const inst of job.solved.instances) {
    if (!job.instByPart.has(inst.src)) job.instByPart.set(inst.src, []);
    job.instByPart.get(inst.src).push(inst);
  }
  // mid-build the pedestal is half empty on purpose — leave it to Rivet
  if (buildSettled()) {
    job.placed = world.rebuildAssembly(job.solved);
  }
  setModelExport(buildSettled());
  pushToCad();
  renderTraveler();
}

/* The whole point of the bench. A person looked at the thing, decided it
   was wrong, and fixed it — so the corrected geometry becomes the recipe
   and the diff becomes the lessons. */
async function teachFromBench() {
  if (!job.plan || !job.solved) return;
  const note = $('#cadTeachNote');
  const after = planParts(job.plan);
  const edits = job.asPlanned ? describeEdits(job.asPlanned, after) : [];

  const reflection = job.reflection
    ? { ...job.reflection, lessons: [...edits, ...(job.reflection.lessons || [])] }
    : { ...deterministicReflection(job.request || job.plan.title, job.plan, job.solved, edits), lessons: edits.length ? edits : undefined };
  if (!reflection.lessons || !reflection.lessons.length) {
    reflection.lessons = [`A ${reflection.object_class} that was signed off by hand on the bench.`];
  }
  reflection.roles = after.map((p, i) => ({ i, role: p.name || p.shape }));

  const { skills: next, skill } = learn(skills, {
    request: job.request || job.plan.title,
    plan: job.plan,
    solved: job.solved,
    reflection,
    corrections: edits,
    clean: false,
    taught: true
  });
  skills = next;
  await persistSkills();
  renderSkills();

  job.asPlanned = structuredClone(after);
  job.reflection = reflection;
  note.textContent = edits.length
    ? `Filed under "${skill.class}". ${edits.length} correction${edits.length === 1 ? '' : 's'} recorded.`
    : `Filed under "${skill.class}" — this version is now the one he starts from.`;
  log(`taught by hand: <b>${esc(skill.name)}</b> is now the recipe for ${esc(skill.class)} (${Math.round(skill.confidence * 100)}% sure)`, 'hi');
  edits.slice(0, 3).forEach(e => log('  learns: ' + esc(e), 'ok'));
}

/* ---- toolbar ---- */
$('#cadTools').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.view) {
    cad.setView(b.dataset.view);
    mark('#cadTools [data-view]', b);
  } else if (b.dataset.proj) {
    cad.setOrtho(b.dataset.proj === 'ortho');
  } else if (b.dataset.mode) {
    cad.setMode(b.dataset.mode);
    mark('#cadTools [data-mode]', b);
  } else if (b.dataset.cmd === 'fit') {
    cad.frameAll();
  } else if (b.dataset.tool === 'measure') {
    b.classList.toggle('on', cad.toggleMeasure());
  } else if (b.dataset.tool === 'isolate') {
    b.classList.toggle('on', cad.toggleIsolate());
  } else if (b.dataset.section) {
    const on = !cad.section.on;
    cad.setSection({ on });
    b.classList.toggle('on', on);
  }
});
$('#cadExplode').addEventListener('input', e => cad.setExplode(Number(e.target.value)));
$('#cadUnit').addEventListener('change', e => cad.setUnit(e.target.value));
$('#cadSectionAxis').addEventListener('change', e => cad.setSection({ axis: Number(e.target.value) }));
$('#cadSectionAt').addEventListener('input', e => cad.setSection({ offset: Number(e.target.value) }));

/* The parts list, as a shop would order it. */
$('#cadBom').onclick = async () => {
  if (!job.solved) { log('nothing on the bench to list', 'err'); return; }
  const rows = bom(job.solved, planParts(job.plan));
  const res = await window.forge.saveModel({
    name: `${slug()}-parts`, ext: 'csv', data: bomCSV(rows, { unit: cad.unit })
  });
  if (res?.ok) log(`wrote a parts list — ${rows.length} line${rows.length === 1 ? '' : 's'}, ` +
    `${rows.reduce((n, r) => n + r.qty, 0)} pieces`, 'ok');
};
function mark(sel, on) {
  document.querySelectorAll(sel).forEach(b => b.classList.toggle('on', b === on));
}

/* ---- browser tree ---- */
$('#cadTree').addEventListener('click', e => {
  const eye = e.target.closest('.cadEye');
  if (eye) { cad.toggleHidden(Number(eye.dataset.eye)); e.stopPropagation(); return; }
  const row = e.target.closest('.cadRow');
  if (row) cad.select(Number(row.dataset.part));
});

/* ---- properties ---- */
const FIELD_KEYS = new Set(['name', 'shape', 'material', 'sx', 'sy', 'sz', 'rx', 'ry', 'rz',
  'to', 'face', 'dx', 'dy', 'dz', 'mode', 'count', 'radius']);
$('#cadSide').addEventListener('input', e => {
  const f = e.target.dataset.f;
  if (!FIELD_KEYS.has(f) || cad.selected == null) return;
  // half-typed numbers report as "" — leave the part alone until there is
  // a real value, or the model jumps about while you are still typing it
  if (e.target.type === 'number' && e.target.value === '') return;
  // the panel is in millimetres, the spec is in metres — cad owns that
  // conversion because cad owns which unit is on screen
  cad.onEdit(cad.selected, { [f]: cad.fieldToSpec(f, e.target.value) });
});
// a select commits on change, and a text field on blur — either way the
// panel can safely be rebuilt now, so dependent fields catch up
$('#cadSide').addEventListener('change', e => {
  if (FIELD_KEYS.has(e.target.dataset.f)) cad.renderProps(true);
});
$('#cadSide').addEventListener('focusout', () => setTimeout(() => {
  if (!$('#cadSide').contains(document.activeElement)) cad.renderProps(true);
}, 0));
$('#cadSide').addEventListener('click', e => {
  const b = e.target.closest('button[data-cmd]');
  if (b) cad.onCommand(b.dataset.cmd);
});

/* ------------------------------------------------------------------ */
/* camera input                                                        */
/* ------------------------------------------------------------------ */
let dragging = false, lastX = 0, lastY = 0, dragMoved = 0, panning = false;
const cv = $('#cv');

cv.addEventListener('pointerdown', e => {
  dragging = true; dragMoved = 0;
  panning = cad.active && (e.button === 1 || e.shiftKey);
  lastX = e.clientX; lastY = e.clientY;
  cv.setPointerCapture(e.pointerId);
});

cv.addEventListener('pointerup', e => {
  const wasDragging = dragging;
  dragging = false;
  // a click, not an orbit: pick whatever is under the cursor
  if (cad.active && wasDragging && dragMoved < 5) {
    const r = stage.getBoundingClientRect();
    const hit = cad.pick(e.clientX - r.left, e.clientY - r.top, r.height);
    if (hit && hit.cube) cad.setView(hit.cube);
    else if (hit && 'part' in hit) {
      if (cad.measure.on) cad.measurePick(hit.part); else cad.select(hit.part);
    }
  }
  panning = false;
});

cv.addEventListener('pointermove', e => {
  if (!dragging) return;
  const dx = e.clientX - lastX, dy = e.clientY - lastY;
  dragMoved += Math.abs(dx) + Math.abs(dy);
  lastX = e.clientX; lastY = e.clientY;

  if (cad.active) {
    const o = cad.orbit;
    if (panning) {
      // drag the model with the cursor, in the camera's own plane
      const k = o.dist * 0.0016;
      const right = new THREE.Vector3().setFromMatrixColumn(cad.camera.matrix, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(cad.camera.matrix, 1);
      o.target.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
    } else {
      o.yaw -= dx * 0.006;
      o.pitch = Math.max(-1.5, Math.min(1.5, o.pitch + dy * 0.005));
    }
    return;
  }
  world.camOrbit.yaw -= dx * 0.005;
  world.camOrbit.pitch = Math.max(-0.05, Math.min(0.85, world.camOrbit.pitch + dy * 0.003));
});

cv.addEventListener('wheel', e => {
  e.preventDefault();
  if (cad.active) {
    cad.orbit.dist = Math.max(0.35, Math.min(24, cad.orbit.dist * Math.exp(e.deltaY * 0.0014)));
    return;
  }
  world.camOrbit.dist = Math.max(5, Math.min(38, world.camOrbit.dist * Math.exp(e.deltaY * 0.0012)));
}, { passive: false });

const roomBtns = $('#roomBtns');
ROOM_ORDER.forEach((k, i) => {
  const b = document.createElement('button');
  b.textContent = `${i + 1} ${ROOMS[k].label}`;
  b.onclick = () => focusRoom(k);
  b.dataset.room = k;
  roomBtns.appendChild(b);
});
function focusRoom(k) {
  $('#followCam').checked = false;
  world.lookAtRoom(k);
  [...roomBtns.children].forEach(b => b.classList.toggle('on', b.dataset.room === k));
  $('#roomTag').textContent = ROOMS[k].label;
}
const CAD_KEY_VIEWS = ['front', 'top', 'right', 'iso'];
addEventListener('keydown', e => {
  /* Undo is checked before the field guard on purpose: the edit it steps
     back is one made by typing in those very fields, so it has to work
     while the caret is still sitting in one. */
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && cad.active) {
    e.preventDefault();
    e.shiftKey ? redoEdit() : undoEdit();
    return;
  }
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
  const k = e.key.toLowerCase();
  if (k === 'b') { toggleCad(); return; }
  if (e.key === 'Escape' && cad.active) { closeCad(); return; }

  const n = '1234'.indexOf(e.key);
  if (cad.active) {
    // the number keys switch view, not room, while you are on the bench
    if (n >= 0) {
      cad.setView(CAD_KEY_VIEWS[n]);
      mark('#cadTools [data-view]', $(`#cadTools [data-view="${CAD_KEY_VIEWS[n]}"]`));
    }
    if (k === 'f') cad.frameAll();
    if (k === 'x') { cad.setMode(cad.mode === 'xray' ? 'shaded' : 'xray'); mark('#cadTools [data-mode]', $(`#cadTools [data-mode="${cad.mode}"]`)); }
    if (k === 'm') $('#cadMeasure').classList.toggle('on', cad.toggleMeasure());
    if (k === 'i') $('#cadIsolate').classList.toggle('on', cad.toggleIsolate());
    if (k === 's') { const on = !cad.section.on; cad.setSection({ on }); $('#cadSectionBtn').classList.toggle('on', on); }
    return;
  }
  if (n >= 0) focusRoom(ROOM_ORDER[n]);
  if (k === 'f') { $('#followCam').checked = true; }
});

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */
async function loadCfg() {
  const c = await window.forge.getCfg();
  $('#cfgProvider').value = c.provider;
  $('#cfgNimKey').value = c.nimKey;
  $('#cfgNimModel').value = c.nimModel;
  $('#cfgOllamaModel').value = c.ollamaModel;
  $('#cfgReferences').value = c.references || 'auto';
  $('#cfgThingiverse').value = c.thingiverseToken || '';
}
async function saveCfg() {
  await window.forge.setCfg({
    provider: $('#cfgProvider').value,
    nimKey: $('#cfgNimKey').value.trim(),
    nimModel: $('#cfgNimModel').value.trim(),
    ollamaModel: $('#cfgOllamaModel').value.trim(),
    references: $('#cfgReferences').value,
    thingiverseToken: $('#cfgThingiverse').value.trim()
  });
}
['#cfgProvider', '#cfgNimKey', '#cfgNimModel', '#cfgOllamaModel', '#cfgReferences', '#cfgThingiverse'].forEach(s => $(s).addEventListener('change', saveCfg));
$('#btnSettings').onclick = () => $('#modal').hidden = false;
$('#btnCloseModal').onclick = async () => { await saveCfg(); $('#modal').hidden = true; };
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') $('#btnCloseModal').click(); });
document.querySelectorAll('[data-url]').forEach(a => a.onclick = e => { e.preventDefault(); window.forge.openUrl(a.dataset.url); });

$('#btnProbe').onclick = async () => {
  await saveCfg();
  $('#probeOut').textContent = 'testing…';
  const r = await window.forge.probe();
  const lines = [];
  if (r.nim?.ok) {
    lines.push(`NIM      ok — ${r.nim.models.length} models reachable`);
    fill('#nimModels', r.nim.models);
  } else lines.push(`NIM      unavailable — ${r.nim?.error}`);
  if (r.ollama?.ok) {
    lines.push(`Ollama   ok — ${r.ollama.models.join(', ') || 'no models pulled yet'}`);
    fill('#ollamaModels', r.ollama.models);
  } else lines.push(`Ollama   unavailable — ${r.ollama?.error}`);
  if (r.refs?.ok) lines.push(`Refs     ok — ${r.refs.found} designs found (${r.refs.notes.join('; ')})`);
  else lines.push(`Refs     ${r.refs?.error || 'nothing came back'}${r.refs?.notes?.length ? ` — ${r.refs.notes.join('; ')}` : ''}`);
  $('#probeOut').textContent = lines.join('\n');
  log('engine probe: ' + esc(lines.join(' | ')));
};
function fill(sel, items) {
  const dl = $(sel); dl.innerHTML = '';
  for (const m of items) { const o = document.createElement('option'); o.value = m; dl.appendChild(o); }
}

$('#btnSkillExport').onclick = async () => {
  const r = await window.forge.skills.export();
  if (r.ok) log(`exported ${skills.length} skill${skills.length === 1 ? '' : 's'}`, 'ok');
};
$('#btnSkillImport').onclick = async () => {
  const r = await window.forge.skills.import();
  if (!r.ok) { if (r.error) log('import failed: ' + esc(r.error), 'err'); return; }
  const { skills: next, added, replaced, kept } = mergeLibraries(skills, r.skills);
  skills = next;
  await persistSkills();
  renderSkills();
  log(`imported — ${added} new, ${replaced} replaced with a more confident version` +
      (kept ? `, ${kept} left alone because what he already knows is better` : ''), 'ok');
};

/* ------------------------------------------------------------------ */
/* prompts                                                             */
/* ------------------------------------------------------------------ */
const SEEDS = [
  'a desk lamp with a folding arm',
  'a cardboard robot with working elbows',
  'a wall shelf that holds twelve records',
  'a rover chassis with four wheels',
  'a coffee grinder stand',
  'a rocket model with fins'
];
SEEDS.forEach(s => {
  const c = document.createElement('span');
  c.className = 'chip'; c.textContent = s;
  c.onclick = () => { $('#req').value = s; };
  $('#chips').appendChild(c);
});

$('#btnBuild').onclick = requestBuild;
$('#btnStop').onclick = () => stopJob('stopped by hand');
$('#btnExport').onclick = () => {
  if (!job.plan) return;
  const slug = job.plan.title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'build';
  const payload = {
    request: job.request,
    plan: job.plan,
    assembly: job.solved ? job.solved.instances.map(i => ({
      name: i.name, shape: i.shape, material: i.material,
      size: i.size, at: i.pos.map(v => +v.toFixed(3)), rot: i.rot
    })) : []
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${slug}.json`; a.click();
  URL.revokeObjectURL(url);
  log(`exported <b>${esc(slug)}.json</b>`, 'ok');
};
$('#req').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) requestBuild();
});

/* ------------------------------------------------------------------ */
/* the object itself, off the pedestal                                 */
/* ------------------------------------------------------------------ */
/* Everything up to here has been about making the thing exist on screen.
   This is the part that makes it exist anywhere else. */
function setModelExport(on) {
  const ready = !!(on && job.solved && job.placed > 0);
  $('#btnStl').disabled = !ready;
  $('#btnObj').disabled = !ready;
}

const slug = () => (job.plan?.title || 'build').trim().toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'build';

/* One group per part so the assembly opens as an assembly, with all the
   weld beads and bolts collapsed into a single "seams" object — otherwise
   a welded joint alone is twenty objects called bead_1..bead_20. */
function exportGroups() {
  const meshes = world.assemblyMeshes();
  const groups = [];
  const seams = [];
  const seen = new Map();

  for (const m of meshes) {
    const tris = trianglesFrom(m);
    if (!tris.length) continue;
    if (m.seam) { seams.push(tris); continue; }
    // two parts called "leg" must not become one object called "leg"
    const n = (seen.get(m.name) || 0) + 1;
    seen.set(m.name, n);
    groups.push({ name: n > 1 ? `${m.name}_${n}` : m.name, tris });
  }

  if (seams.length) {
    const total = seams.reduce((n, t) => n + t.length, 0);
    const all = new Float32Array(total);
    let o = 0;
    for (const t of seams) { all.set(t, o); o += t.length; }
    groups.push({ name: 'seams', tris: all });
  }
  return groups;
}

async function exportModel(kind) {
  if (!job.solved || !job.placed) return;
  const groups = exportGroups();
  if (!groups.length) { log('nothing on the pedestal to export', 'err'); return; }

  const info = summarise(groups);
  const data = kind === 'stl' ? toSTL(groups) : toOBJ(groups);
  const res = await window.forge.saveModel({ name: slug(), ext: kind, data });

  if (res?.cancelled) return;
  if (!res?.ok) { log(`could not write the ${kind.toUpperCase()}: ${esc(res?.error || 'unknown error')}`, 'err'); return; }
  log(`wrote <b>${esc(res.path.split('/').pop())}</b> — ${info.parts} object${info.parts === 1 ? '' : 's'}, ` +
      `${info.triangles.toLocaleString()} triangles, ${(res.bytes / 1024).toFixed(0)} kB` +
      (kind === 'stl' ? ' · millimetres, Z up' : ' · millimetres, Y up'), 'ok');
}

$('#btnStl').onclick = () => exportModel('stl');
$('#btnObj').onclick = () => exportModel('obj');

/* ------------------------------------------------------------------ */
/* loop                                                                */
/* ------------------------------------------------------------------ */
function resize() {
  const r = stage.getBoundingClientRect();
  world.resize(r.width, r.height);
  cad.layout(r.width, r.height);
}
new ResizeObserver(resize).observe(stage);
resize();

const tmp = new THREE.Vector3();
let last = performance.now(), T = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now; T += dt;

  if (job.running || job.phase === 'wrap') stepTick(dt);
  else idleTick(dt);

  rivet.update(dt);
  world.tick(T, dt);

  let follow = $('#followCam').checked ? tmp.copy(rivet.pos) : null;
  // while he's working, sit the camera between him and the bench so the
  // material being cut or bent is what you're actually looking at
  if (follow && job.phase === 'work' && job.plan && job.i >= 0) {
    const b = ROOMS[job.plan.steps[job.i].room].bench;
    follow.x = follow.x * 0.4 + b[0] * 0.6;
    follow.z = follow.z * 0.4 + (b[1] + 0.35) * 0.6;
  }
  // and while he's setting parts down, look at the pedestal, not at him
  if (follow && job.phase === 'haul' && job.haul?.stage === 'place') {
    follow.x = follow.x * 0.35 + ROOMS.finished.x * 0.65;
    follow.z = follow.z * 0.35 + PEDESTAL_Z * 0.65;
  }
  world.updateCamera(dt, follow);

  if (follow) {
    let nearest = ROOM_ORDER[0], best = 1e9;
    for (const k of ROOM_ORDER) {
      const d = Math.abs(ROOMS[k].x - rivet.pos.x);
      if (d < best) { best = d; nearest = k; }
    }
    if ($('#roomTag').textContent !== ROOMS[nearest].label) {
      $('#roomTag').textContent = ROOMS[nearest].label;
      [...roomBtns.children].forEach(b => b.classList.toggle('on', b.dataset.room === nearest));
    }
  }

  // one canvas, one context: the bench scissors itself over the shop
  if (cad.active) cad.render(); else world.render();
  requestAnimationFrame(frame);
}

/* ------------------------------------------------------------------ */
(async function boot() {
  await loadCfg();
  await loadSkills();
  log(`shop open — four rooms, ${CLIPS.length} animations loaded`, 'hi');
  if (skills.length) log(`${skills.length} skill${skills.length === 1 ? '' : 's'} on file — ${skills.map(s => s.class).join(', ')}`, 'hi');
  const r = await window.forge.probe();
  if (r.nim?.ok) { setEngine('NIM ready', 'nim'); fill('#nimModels', r.nim.models); log(`NVIDIA NIM reachable (${r.nim.models.length} models)`, 'ok'); }
  else if (r.ollama?.ok) { setEngine('Ollama ready', 'ollama'); fill('#ollamaModels', r.ollama.models); log(`NIM unavailable (${esc(r.nim?.error)}); Ollama is up`, 'hi'); }
  else { setEngine('offline planner', 'offline'); log('no model reachable — open Engine to add a key or start Ollama', 'err'); }
  rivet.play('wave');
  caption('waving', 'Tell me what to build.');
  requestAnimationFrame(frame);
})();
