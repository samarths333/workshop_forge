import * as THREE from 'three';
import { World, ROOMS, ROOM_ORDER, PEDESTAL_Z } from './world.js';
import { Crew, ARMFUL } from './crew.js';
import { CLIP_BY_ID, CLIPS } from './animations.js';
import { CREW, SPECIALISTS, roleById, JARVIS, FOREMAN } from './roles.js';
import { ShopFloor, jarvisReport } from './shopfloor.js';
import { orderFromParts, describeOrder } from './workorder.js';
import { attributePlan, crewTally } from './crewplan.js';
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
import { SOURCES, classifyRequest, sourcesFor, searchTerms, enrichRefs, mergeRefs, rankRefs, domainKnowledge, worthReading, minePages } from './library.js';
import { analyse, applyFinding, summariseFindings } from './optimize.js';
import { describeCircuit, COMPONENTS, isComponent } from './circuit.js';
import { describeEngine, engineMotion } from './engine.js';
import { catalogMotion, matchArchetype } from './catalog.js';
import { nextProject, shouldStudy, studyOutcome, studyReport, recordCrew, FAIL_STREAK_STOP } from './apprentice.js';
import { registerShapes, upsertShape, removeShape, newShapeFrom, shapeDef, allShapes, customShapes } from './shapelib.js';
import { PROVIDERS, TIERS, TIER_LABEL, providerById, usableChain, engineLabel } from './providers.js';
import { ACTIONS, actionById, isAvailable, actionForKey } from './actions.js';
import { Palette, bindPaletteHotkey } from './palette.js';

const $ = s => document.querySelector(s);
const stage = $('#stage');
const world = new World($('#cv'));

/* The floor. Five robots, each with its own queue, all ticked from the same
   frame. Everything that touches the DOM or the pedestal is handed to the
   crew as a callback, so crew.js stays about robots and benches and this
   file stays about the app. */
const crew = new Crew(world, {
  onStepStart: (bot, step) => {
    caption(CLIP_BY_ID[step.action].label, step.say);
    log(`<b>${bot.name}</b> · ${step.action.replace(/_/g, ' ')} — ${esc(step.say)}`, 'by-' + bot.role);
    markActive();
  },
  onProgress: (bot, k) => { if (bot === focusBot()) renderProgress(k); },
  onPartMade: (bot, step, partIndex) => {
    job.parts++;
    const n = (job.instByPart.get(partIndex) || []).length;
    log(`  ↳ <b>${esc(bot.name)}</b> made <b>${esc(step.part.name)}</b>${n > 1 ? ` \u00d7${n}` : ''} (${step.part.shape}, ${step.part.material}) — on the rack`, 'ok');
    markActive();
    renderCrew();
  },
  onBotDone: (bot) => { markActive(); renderCrew(); },
  onCaption: (bot, act, say) => caption(act, say),
  onPickUp: (bot, room, n) => log(`  ↳ ${bot.name} picked up ${n} part${n === 1 ? '' : 's'} from the ${room} rack`),
  onPlace: (bot, mesh) => placePart(mesh),
  onFloorDone: () => finishJob()
});

/* The foreman hauls, fits and presents, so he is the one the camera falls
   back to and the one every "he" in the old code meant. */
const rivet = crew.foreman;

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
  running: false,
  parts: 0, placed: 0,
  instByPart: new Map(),
  recalled: null, corrections: [], clean: true, learned: false,
  reflection: null, asPlanned: null, edited: false, refs: [], read: [],
  findings: [], isStudy: false, study: null, domain: null,
  /* Five robots means there is no single "current step" any more. What the
     traveller ticket shows instead is a set of steps already stamped off and
     a set being worked right now — usually four at once, one per trade. */
  done: new Set(), active: new Set(),
  order: null, ledger: null, report: ''
};

/* true once every part is on the pedestal and nothing is mid-flight —
   which is when a CAD edit can safely re-place the whole assembly */
const buildSettled = () => !!job.plan && !job.running && job.placed > 0;

/* Which robot the camera and the caption bar are about. Whoever is actually
   working on something wins; the foreman is the fallback because he is the
   one hauling and presenting when nobody else is doing anything. */
function focusBot() {
  if (crew.phase === 'haul' || crew.phase === 'finishing') return crew.foreman;
  const busy = crew.bots.filter(b => b.phase === 'work');
  if (busy.length) return busy.reduce((a, b) => (a.t / (a.step?.step.seconds || 1) > b.t / (b.step?.step.seconds || 1) ? b : a));
  return crew.bots.find(b => b.phase === 'walk') || crew.foreman;
}

/* Which steps are being worked this instant, for the ticket. Recomputed
   rather than tracked incrementally: six robots each finishing whenever
   they finish is exactly the situation where an incrementally maintained
   set drifts and nobody notices until a row stays lit forever. */
function markActive() {
  if (!job.plan) return;
  const idx = new Map(job.plan.steps.map((s, i) => [s, i]));
  job.active = new Set();
  for (const bot of crew.bots) {
    if (bot.step && (bot.phase === 'work' || bot.phase === 'walk')) {
      const i = idx.get(bot.step.step);
      if (i != null) { job.active.add(i); job.done.delete(i); }
    }
    for (const item of bot.queue) job.done.delete(idx.get(item.step));
  }
  for (let i = 0; i < job.plan.steps.length; i++) {
    if (!job.active.has(i) && !pending(i, idx)) job.done.add(i);
  }
  renderTraveler();
}

function pending(i, idx) {
  const step = job.plan.steps[i];
  for (const bot of crew.bots) {
    if (bot.step?.step === step) return true;
    for (const item of bot.queue) if (item.step === step) return true;
  }
  for (const item of crew.foremanQueue || []) if (item.step === step) return true;
  return false;
}

function startJob(plan, solved) {
  job.plan = plan; job.solved = solved;
  job.running = true; job.parts = 0; job.placed = 0; job.learned = false;
  job.done = new Set(); job.active = new Set();
  for (const bot of crew.bots) { world.releaseWork(bot.wp, false); bot.wp = null; }
  world.clearAssembly();
  crew.stop();

  job.instByPart = new Map();
  for (const inst of solved.instances) {
    if (!job.instByPart.has(inst.src)) job.instByPart.set(inst.src, []);
    job.instByPart.get(inst.src).push(inst);
  }

  crew.load(plan);
  renderTraveler();
  renderCrew();
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

  const tally = crewTally(plan);
  const who = Object.entries(tally)
    .filter(([, t]) => t.parts > 0)
    .map(([id, t]) => `${roleById(id)?.name || id} ${t.parts}`)
    .join(', ');
  log(`job on the floor: <b>${esc(plan.title)}</b> — ${plan.steps.length} operations, ${solved.instances.length} components${who ? ` · ${who}` : ''}`, 'hi');
}

function stopJob(reason) {
  job.running = false;
  crew.stop();
  job.plan && renderTraveler();
  renderCrew();
  renderProgress(0);
  $('#btnStop').disabled = true;
  $('#btnBuild').disabled = false;
  if (reason) log(reason, 'err');
}

function finishJob() {
  if (!job.running) return;
  job.running = false;
  const seams = world.buildSeams(job.solved.joints);
  const wires = world.buildWires(job.plan.wires, job.solved.instances);
  log(`job complete — ${job.placed} component${job.placed === 1 ? '' : 's'} on the pedestal${seams ? `, ${seams} joint${seams === 1 ? '' : 's'} made good` : ''}${wires ? `, ${wires} wire${wires === 1 ? '' : 's'} run` : ''}`, 'ok');
  if (job.plan.wires?.length) {
    describeCircuit(planParts(job.plan), job.plan.wires).split('\n').forEach(l => log('  ' + esc(l), 'hi'));
  }
  if (job.plan.engine) {
    describeEngine(job.plan).split('\n').forEach(l => log('  ' + esc(l), 'hi'));
    log('press <b>R</b> to turn it over', 'hi');
  }
  crew.foreman.play('present');
  for (const bot of crew.bots) if (bot !== crew.foreman) bot.play('thumbs_up');
  caption('handing it over', job.plan.summary || 'Done.');
  $('#btnStop').disabled = true;
  $('#btnBuild').disabled = false;
  setModelExport(true);
  job.done = new Set(job.plan.steps.map((_, i) => i));
  job.active = new Set();
  renderTraveler();
  renderCrew();
  pushToCad();
  // the engineer's second look happens on every build, watched or not —
  // a study build that falls over has to know it fell over
  runOptimiser('floor');
  sayJarvis();
  reflectAndLearn();
}

/* Jarvis speaks for the floor, and only once the floor has finished. He is
   handed the ledger rather than the object: who delivered, who did not, and
   what is still open. */
function sayJarvis() {
  if (!job.ledger || !job.order) return;
  job.report = jarvisReport({
    order: job.order, ledger: job.ledger, plan: job.plan,
    issues: job.corrections, findings: job.findings
  });
  log(`<b>${JARVIS.name}</b>: ${esc(job.report)}`, 'hi');
  const el = $('#jarvisSay');
  if (el) el.textContent = job.report;
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
  log(`  ↳ set <b>${esc(label)}</b>${insts.length > 1 ? ` \u00d7${insts.length}` : ''} on the pedestal`, 'ok');
  $('#jobParts').textContent = `${job.placed} placed`;
}

function reachAt(inst) {
  const v = new THREE.Vector3(inst.pos[0], inst.pos[1], inst.pos[2]);
  world.assembly.localToWorld(v);
  crew.foreman.reachTarget = v;
}

/* ------------------------------------------------------------------ */
/* the floor at rest                                                   */
/* ------------------------------------------------------------------ */
function idleTick(dt) {
  /* An apprentice left alone in a shop does not stand still, and neither
     does a crew of them. */
  study.idleMs += dt * 1000;
  if (shouldStudy({
    on: study.on, busy: job.running, studying: study.running,
    benchOpen: cad.active, typing: document.activeElement === $('#req'),
    paletteOpen: palette.open,
    failStreak: study.failStreak,
    idleMs: study.idleMs
  })) beginStudy();
}

/* ------------------------------------------------------------------ */
/* the apprenticeship                                                  */
/* ------------------------------------------------------------------ */
/* The apprenticeship's state. `crew` and `failStreak` are new and they are
   the two that changed what it studies:

     crew        per-trade counters across recent builds — who keeps having
                 parts taken off them, who keeps failing to deliver. It is
                 what turns "practise something" into "practise the thing
                 that makes the electrical specialist work".
     failStreak  consecutive unsound builds. Three and it stops. Practice
                 fixes a bad recipe; it does not fix a wrong key or a model
                 that will not emit JSON, and from in here those look
                 identical — so the shop stops rather than spending the
                 night proving it. */
const study = { on: false, running: false, idleMs: 0, done: [], built: 0, kept: 0, crew: {}, failStreak: 0 };

/* Everything the study policy needs to choose, in one place — so what the
   picker sees and what the report shows can never drift apart. */
const studyContext = () => ({
  skills, done: study.done, refs: job.refs, crew: study.crew, built: study.built
});

/* Anything the person does is the end of study time, immediately. An app
   that keeps animating while you are trying to read it is an app you turn
   off — so this is deliberately blunt and fires on any input at all. */
function interrupt() {
  study.idleMs = 0;
  if (!study.running) return;
  study.running = false;
  job.study = null;
  stopJob('you have the floor — he will get back to it');
}

/* `force` is the palette asking for it on purpose. A person pressing
   "practise something now" is not unattended, so the fail-streak brake and
   the offline-unless-allowed rule do not apply to them. */
async function beginStudy(force = false) {
  const pick = nextProject(studyContext());
  if (!pick) {
    study.idleMs = 0;
    if (force) log('nothing left it has not tried recently — give it something', 'err');
    return;
  }

  study.running = true;
  study.idleMs = 0;
  study.done.push(pick.request);
  if (study.done.length > 40) study.done.splice(0, study.done.length - 40);
  job.study = pick;

  log(`nothing on the board — <b>${esc(pick.request)}</b>`, 'study');
  log(`  [${pick.kind}] ${esc(pick.why)}`, 'study');
  setStudyBadge();

  // he studies on what he has: offline unless he has been told he may use
  // the engine unattended, because nobody wants to find out their key was
  // spent overnight on a robot practising stools
  await requestBuild({ request: pick.request, study: true, offline: !(study.engine || force) });
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
  $('#jobSummary').textContent = p ? p.summary : 'Give the floor a build request. The manager splits it up, the trades work it in parallel, and every operation lands here stamped with whose it is.';
  const ol = $('#steps'); ol.innerHTML = '';
  if (!p) { $('#jobCount').textContent = '0 / 0 operations'; $('#jobParts').textContent = '0 parts'; return; }
  p.steps.forEach((s, i) => {
    const li = document.createElement('li');
    li.className = job.active.has(i) ? 'now' : (job.done.has(i) ? 'done' : '');
    const n = s.part ? (job.instByPart.get(partIndexOf(p, i)) || []).length : 0;
    const who = roleById(s.by);
    li.innerHTML =
      `<span class="n">${String(i + 1).padStart(2, '0')}</span><div>
       <div class="sSay">${esc(s.say)}</div>
       <div class="sMeta">${who ? `<b class="sWho" style="color:#${(who.accent || 0xffffff).toString(16).padStart(6, '0')}">${esc(who.name)}</b> · ` : ''}${s.room} · ${s.action.replace(/_/g, ' ')} · ${s.seconds}s</div>
       ${s.part ? `<span class="sPart">${esc(s.part.name)}${n > 1 ? ` \u00d7${n}` : ''} — ${s.part.shape}/${s.part.material}</span>` : ''}
       ${job.active.has(i) ? '<div class="sBar"><span></span></div>' : ''}
     </div>`;
    ol.appendChild(li);
  });
  $('#jobCount').textContent = `${job.done.size} / ${p.steps.length} operations`;
  $('#jobParts').textContent = job.placed ? `${job.placed} placed` : `${job.parts} made`;
  const now = ol.querySelector('.now');
  if (now) now.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/* ------------------------------------------------------------------ */
/* the crew panel                                                      */
/* ------------------------------------------------------------------ */
/* One row per robot: who they are, what they were told to do, and where
   that task got to. The delegation half comes from the ledger and the
   movement half from the floor, and they are deliberately drawn together —
   "assigned three parts, delivered three, currently welding" is one thought
   and it takes both halves to say it. */
function renderCrew() {
  const el = $('#crewRows');
  if (!el) return;
  const live = new Map(crew.status().map(s => [s.role, s]));
  const tasks = new Map((job.ledger?.tasks || []).map(t => [t.role, t]));
  el.innerHTML = '';
  for (const role of CREW) {
    const st = live.get(role.id) || {};
    const t = tasks.get(role.id);
    const hex = '#' + (role.accent || 0xffffff).toString(16).padStart(6, '0');
    const state = st.phase === 'work' ? 'working'
      : st.phase === 'walk' ? 'walking'
        : st.left ? `${st.left} to go`
          : t ? t.status : 'idle';
    const cls = st.phase === 'work' || st.phase === 'walk' ? 'on'
      : t?.status === 'failed' || t?.status === 'denied' ? 'bad'
        : t?.status === 'delivered' ? 'ok' : '';
    const row = document.createElement('div');
    row.className = 'crewRow ' + cls;
    row.innerHTML =
      `<span class="cDot" style="background:${hex}"></span>
       <div class="cWho"><b>${esc(role.name)}</b><span>${esc(role.trade)}</span></div>
       <div class="cTask">${esc(t?.brief || role.say || '')}</div>
       <div class="cState">${esc(state)}${st.doing ? ` · ${esc(st.doing)}` : ''}</div>
       <div class="cNum">${st.made || t?.delivered || 0}</div>`;
    row.title = t ? `${t.status}${t.reason ? ` — ${t.reason}` : ''}${t.notes ? `\n${t.notes}` : ''}` : role.trade;
    el.appendChild(row);
  }
}

function partIndexOf(plan, stepIndex) {
  let n = 0;
  for (let i = 0; i < stepIndex; i++) if (plan.steps[i].part) n++;
  return n;
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ------------------------------------------------------------------ */
/* the shape library                                                   */
/* ------------------------------------------------------------------ */
/* Shapes somebody made. Registered BEFORE the first build so the planner's
   enum, the crew's schemas and the bench picker all see them — the enum is
   one array mutated in place, so registering late would leave whatever
   already grabbed a reference holding yesterday's vocabulary. */
let myShapes = [];

async function loadShapes() {
  try { myShapes = registerShapes(await window.forge.shapes.load()); }
  catch { myShapes = registerShapes([]); }
  return myShapes;
}

async function persistShapes() {
  try { await window.forge.shapes.save(myShapes); }
  catch (e) { log('could not write the shape library: ' + e.message, 'err'); }
}

/* Save one, register it, and tell the bench. Everything that adds a shape
   comes through here so there is one place the three of those happen. */
async function saveShape(def) {
  const r = upsertShape(myShapes, def);
  if (!r.ok) { log(esc(r.error), 'err'); return r; }
  myShapes = registerShapes(r.list);
  await persistShapes();
  cad.refreshShapes?.();
  log(`shape <b>${esc(r.shape.id)}</b> saved — ${myShapes.length} of your own now`, 'ok');
  return r;
}

async function deleteShape(id) {
  const inUse = (job?.plan ? planParts(job.plan) : []).filter(p => p.shape === id);
  if (inUse.length) {
    log(`"${esc(id)}" is used by ${inUse.length} part${inUse.length === 1 ? '' : 's'} on the bench — those become boxes`, 'err');
  }
  const r = removeShape(myShapes, id);
  if (!r.ok) return false;
  myShapes = registerShapes(r.list);
  await persistShapes();
  cad.refreshShapes?.();
  log(`shape <b>${esc(id)}</b> deleted`, '');
  return true;
}

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
        REFLECT_SCHEMA, 'reflect'
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

  /* A study build only gets to teach him something if it came out sound.
     He marked his own homework, so the bar is higher and the reward is
     lower — see SELF_TAUGHT_CEILING. */
  /* The crew tally goes in whether this was a study build or not — a trade
     that keeps having its parts taken off it is the most useful thing the
     floor knows about itself, and it is invisible in the geometry. */
  study.crew = recordCrew(study.crew, job.ledger?.tasks || []);

  const outcome = job.isStudy
    ? studyOutcome({
      issues: [], metrics: assemblyMetrics(job.solved), findings: job.findings || [],
      crew: (job.ledger?.tasks || []).reduce((m, t) => {
        m[t.role] = { failed: t.status === 'failed' || t.status === 'denied' ? 1 : 0, coerced: t.coerced || 0 };
        return m;
      }, {})
    })
    : null;
  if (outcome) {
    reflection = { ...reflection, lessons: [...(reflection.lessons || []), ...outcome.lessons].slice(0, 6) };
  }

  const { skills: next, skill, isNew } = learn(skills, {
    request: job.request, plan: job.plan, solved: job.solved,
    reflection, corrections: job.corrections, clean: job.clean,
    domain: job.domain?.domain,
    self: job.isStudy, keepRecipe: outcome ? outcome.keepRecipe : true
  });
  skills = next;
  await persistSkills();
  renderSkills();

  if (isNew) log(`learned a new skill: <b>${esc(skill.name)}</b> (class ${esc(skill.class)})`, job.isStudy ? 'study' : 'hi');
  else log(`updated what he knows about <b>${esc(skill.class)}</b> — ${skill.stats.uses} builds, ${Math.round(skill.confidence * 100)}% sure`, job.isStudy ? 'study' : 'hi');
  (skill.lessons || []).slice(0, 2).forEach(l => log('  keeps: ' + esc(l)));
  if (again) log('  same fault as last time — the lesson on file is not landing', 'err');

  if (job.isStudy) {
    study.built++;
    if (outcome.keepRecipe) { study.kept++; study.failStreak = 0; }
    else study.failStreak++;
    /* `lastBuilt` is what spaced repetition counts in. Without it a recipe
       that worked once is never re-tested, because confidence only moves
       when something is built. */
    skill.stats = { ...skill.stats, lastBuilt: study.built };
    log(`  ${esc(outcome.note)}`, outcome.sound ? 'ok' : 'err');
    if (study.failStreak >= FAIL_STREAK_STOP) {
      log(`${study.failStreak} unsound builds in a row — stopping. Practice does not fix a bad key or a model that will not emit JSON.`, 'err');
    }
    study.running = false;
    study.idleMs = 0;
    setStudyBadge();
    await persistSkills();
  }
}

/* ------------------------------------------------------------------ */
/* the engineer's second look                                          */
/* ------------------------------------------------------------------ */
/* The critic asked whether it reads as the thing. This asks the
   questions an engineer would ask about the same object: will it stand,
   is the material up to what is sitting on it, is there stock in there
   doing no work, and did we walk the shop six times to make it. All
   arithmetic, none of it in a prompt. */
function runOptimiser(where = 'floor') {
  if (!job.plan || !job.solved) { job.findings = []; return []; }
  job.findings = analyse(job.plan, job.solved);
  renderFindings();

  if (!job.findings.length) {
    if (where === 'floor') log('he looked it over and found nothing worth changing', 'ok');
    return job.findings;
  }
  log(`he looked it over: ${esc(summariseFindings(job.findings))}`, 'hi');
  job.findings.filter(f => f.severity === 'fault').slice(0, 3)
    .forEach(f => log(`  fault: ${esc(f.title)} — ${esc(f.gain || f.why)}`, 'err'));
  return job.findings;
}

/* Findings are offered, never imposed. Every one goes through the same
   editPart the properties panel uses, which means it is clamped by the
   same rules and lands on the undo stack — you can always take back
   something he suggested. */
function renderFindings() {
  const el = $('#cadFindings');
  if (!el) return;
  const list = job.findings || [];
  if (!list.length) {
    el.innerHTML = job.plan
      ? '<div class="fEmpty">Nothing he would change about this one.</div>'
      : '<div class="fEmpty">Nothing on the bench yet.</div>';
    return;
  }
  el.innerHTML = list.map((f, i) => `
    <div class="fRow ${f.severity}">
      <div class="fHead">${esc(f.title)}</div>
      <div class="fWhy">${esc(f.why)}</div>
      <div class="fGain">${esc(f.gain || '')}</div>
      ${f.patch ? `<button class="fApply" data-fix="${i}">Apply</button>` : '<span class="fNote">your call</span>'}
    </div>`).join('');
}

function applyOneFinding(i) {
  const f = (job.findings || [])[i];
  if (!f?.patch) return;
  snapshot(`optimise: ${f.title}`, `fix-${f.id}`);
  job.plan = applyFinding(job.plan, f);
  reSolve();
  log(`applied: ${esc(f.gain || f.title)}`, 'ok');
  job.edited = true;
  // the indices in every other finding may have just moved, so the only
  // honest thing to do is look at the build again
  runOptimiser('bench');
}

/* ------------------------------------------------------------------ */
/* planning                                                            */
/* ------------------------------------------------------------------ */
function setEngine(text, cls) {
  const e = $('#engine');
  e.textContent = text;
  e.className = 'badge ' + cls;
}

async function requestBuild(opts = {}) {
  const text = String(opts.request ?? $('#req').value).trim();
  if (!text) return;
  job.isStudy = !!opts.study;
  $('#btnBuild').disabled = true;
  setEngine('thinking…', 'busy');
  crew.stop();
  crew.foreman.play('think');
  crew.foreman.reachTarget = null;
  for (const bot of crew.bots) if (bot !== crew.foreman) bot.play('idle_look');
  caption('splitting the job up', `${FOREMAN.name} is working out who makes what.`);
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
  const terms = searchTerms(text, domain.domain);
  try {
    const r = await window.forge.refs({ term: text, terms, sources });
    /* Nothing reaches the prompt without sharing a word with the request.
       A source that returns 200 OK and a page of unrelated popular models
       is worse than one that returns nothing, because the prompt then
       teaches the planner that a desk lamp is a boat. */
    const raw = r.refs || [];
    refs = enrichRefs(mergeRefs([rankRefs(raw, terms, text)]));
    const dropped = raw.length - refs.length;
    if (dropped > 0) log(`ignored ${dropped} result${dropped === 1 ? '' : 's'} that had nothing to do with the request`, 'err');
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

  /* Opening the best few and reading them is the whole point. A title is
     what the shop had before and it was not enough — the page behind it
     is where the part names and the dimensions are. */
  let read = [];
  const cfgReadPages = $('#cfgReadPages')?.checked !== false;
  const toRead = cfgReadPages ? worthReading(refs) : [];
  if (toRead.length) {
    try {
      const r = await window.forge.read(toRead);
      read = minePages(r.pages || [], refs);
      if (read.length) {
        log(`read ${read.length} page${read.length === 1 ? '' : 's'} in full`, 'hi');
        read.forEach(p => log(`  ${esc(p.title)}`
          + (p.structure.length ? ` — names ${esc(p.structure.slice(0, 4).join(', '))}` : '')
          + (p.dimensions.length ? `, quotes ${esc(p.dimensions.slice(0, 3).map(d => d.mm + 'mm').join(', '))}` : '')));
      } else if ((r.pages || []).length) {
        log(`opened ${r.pages.length} page${r.pages.length === 1 ? '' : 's'} but none of them described making anything`, 'err');
      }
    } catch (err) {
      log('page reading skipped: ' + esc(err.message), 'err');
    }
  }
  job.read = read;

  /* The classification the reference lookup already worked out, handed to
     recall as a demotion only — a skill learned building a bookshelf is
     not a lead on an engine however its keywords fell out. */
  const recalled = recall(skills, text, { domain: job.domain?.domain });
  job.recalled = recalled;
  if (recalled) {
    log(`recalled <b>${esc(recalled.skill.name)}</b> — built ${recalled.skill.stats.uses}×, matched on ${recalled.matched.map(esc).join(', ')}`, 'hi');
    setRecallBadge(recalled);
  } else {
    setRecallBadge(null);
  }

  /* THE FLOOR TAKES OVER HERE.

     What used to happen was one call: the whole object, from one model, in
     one go. What happens now is a manager pass that fixes the frame and the
     interfaces, then every trade planning its own subassembly at the same
     time against those interfaces, then a merge. It is more calls, but each
     one is a question a model can actually answer well, and that — not the
     number of calls — is why what comes off the floor is better.

     The offline planner is still what the floor falls back on, and it is
     now also what the manager decomposes when no engine answers: the same
     keyword archetypes, split across the trades instead of given to one
     robot. */
  let engine = 'offline planner', cls = 'offline';
  const offline = !!opts.offline;
  const fallbackParts = planParts(validatePlan(offlinePlan(text, recalled), text));

  const floor = new ShopFloor({
    log: (line, c) => log(esc(line), c || ''),
    onEvent: () => { job.ledger = floor.ledger; renderCrew(); },
    ask: async (messages, schema, who) => {
      // studying unattended does not get to spend the key unless it was
      // explicitly allowed to
      if (offline) return { ok: false };
      try {
        const res = await window.forge.plan(messages, schema, who);
        if (res.ok) {
          engine = res.engine;
          cls = /NIM/i.test(res.engine) ? 'nim' : 'ollama';
        } else {
          (res.tried || []).forEach(t => log(`${who}: ` + esc(t), 'err'));
        }
        return res;
      } catch (err) {
        log(`${who} call failed: ` + esc(err.message), 'err');
        return { ok: false };
      }
    }
  });
  job.ledger = floor.ledger;
  renderCrew();

  log(`<b>${JARVIS.name}</b> → <b>${FOREMAN.name}</b>: ${esc(text)}`, 'hi');
  const { order, plan: merged } = await floor.run(text, {
    refs, read, recalled, domain, offline, fallbackParts
  });
  job.order = order;
  job.ledger = floor.ledger;

  let plan;
  try {
    plan = validatePlan(merged, text);
  } catch (err) {
    log('the merged plan would not validate: ' + esc(err.message) + ' — falling back to a single-robot build', 'err');
    plan = attributePlan(validatePlan(offlinePlan(text, recalled), text));
  }
  /* Nothing reaches the floor without an owner on every step. The merge sets
     them; this catches anything validatePlan appended on its way past. */
  attributePlan(plan);

  if (cls === 'offline') {
    log(recalled ? 'no engine reachable — the floor worked from the recipe it already knows' : 'no engine reachable — the floor split up the keyword plan between the trades', 'err');
    crew.foreman.play(recalled ? 'thumbs_up' : 'shrug');
  }

  job.engine = engine; job.cls = cls;
  setEngine(engine, cls);

  const { plan: finalPlan, solved } = await reviewBuild(text, plan, cls, refs, read);
  setEngine(engine, cls);
  startJob(finalPlan, solved);
}

/* Rivet checks his own work before he starts cutting. The solver runs
   first and always — it is local, and it turns the plan into the real
   assembly. Then, if a model is reachable, it gets asked the only question
   arithmetic cannot answer: does this read as the thing that was ordered. */
async function reviewBuild(request, plan, cls, refs, read) {
  crew.foreman.play('inspect');
  caption('checking the drawing', 'Making sure this reads as the thing that was ordered.');

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
      buildCritiqueMessages(request, plan, report.issues, report.description, refs, read),
      REVISE_SCHEMA, 'critic'
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

    const fixed = attributePlan(validatePlan(plan, plan.title));
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

function setStudyBadge() {
  const b = $('#studyBadge');
  if (!b) return;
  if (!study.on) { b.hidden = true; return; }
  b.hidden = false;
  b.textContent = study.running
    ? `studying: ${job.study?.request || 'something'}`
    : study.built ? `studied ${study.built}, kept ${study.kept}` : 'studying when idle';
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
  dom: { root: $('#cad'), tree: $('#cadTree'), side: $('#cadSide'), stats: $('#cadStats'), shapes: $('#cadShapes') }
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
  renderFindings();
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
  /* The engine spec goes on the stack with the steps. It has to: undoing a
     bore change would otherwise put the old part sizes back while leaving
     the new bore in the spec, and the next thing to re-body from the spec
     would silently undo the undo. */
  history.push({ steps: job.plan.steps, engine: job.plan.engine || null }, { label, key });
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
  if (state.engine) job.plan.engine = structuredClone(state.engine);
  else delete job.plan.engine;
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
  /* Making a shape is not editing a build, so it works with an empty
     pedestal — which is exactly when somebody sits down to draw one. */
  if (cmd === 'shapes') return cad.openShapes();
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
    // the wires have to be re-run with the parts: an edit that moves a
    // component leaves its wire hanging in the air otherwise
    world.pendingWires = job.plan.wires;
    job.placed = world.rebuildAssembly(job.solved);
  }
  setModelExport(buildSettled());
  /* Rebuilding the assembly threw away every mesh the engine was turning,
     so a running engine has to be re-bound to the new ones. Leaving it
     bound to the old meshes is the version of this bug that does not
     throw: the panel says it is running and nothing moves. */
  if (job.engineRunning) startEngineRun(true);
  pushToCad();
  renderTraveler();
}

/* ------------------------------------------------------------------ */
/* running the engine                                                  */
/* ------------------------------------------------------------------ */
/* Nothing here decides anything — engine.js works out what turns and how
   fast, world.js turns that into transforms, and this is the switch. */
function startEngineRun(on) {
  /* The engine's own moving parts, and everything ELSE on the object that
     turns. A car with a V12 in it should not be a car with a turning
     crankshaft and four wheels welded solid — the wheels are part of what
     "it works" means, and so are a drone's props and a crane's turntable.
     Both lists come back in the same shape and world.js drives them
     without knowing which is which. */
  const motion = [
    ...(job.plan?.engine ? engineMotion(job.plan) : []),
    ...(job.plan ? catalogMotion(planParts(job.plan)) : [])
  ];
  job.engineRunning = world.runEngine(motion, on);
  const btn = $('#cadRun');
  if (btn) btn.classList.toggle('on', job.engineRunning);
  return job.engineRunning;
}

/* One field on the engine, changed. Everything downstream of it follows:
   the spec is re-clamped, every tagged part is re-bodied from the new
   numbers, and the assembly re-solves. */
function editEngine(set) {
  if (!job.plan?.engine) return;
  const field = Object.keys(set)[0];
  const next = applyFinding(job.plan, { patch: { kind: 'edit-spec', set } });
  if (next === job.plan) return;
  /* Keyed on the field so holding an arrow key is one undo, exactly as a
     size field on a part is. */
  snapshot(`engine: ${field}`, `engine-${field}`);
  job.plan = next;
  job.edited = true;
  reSolve();
  runOptimiser('bench');
}

function toggleEngineRun() {
  if (!job.plan?.engine) { log('nothing on the pedestal that turns', 'err'); return; }
  if (!buildSettled()) { log('let him finish building it first', 'err'); return; }
  const on = startEngineRun(!job.engineRunning);
  log(on ? 'running it' : 'shut it down', on ? 'ok' : '');
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
    domain: job.domain?.domain,
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
/* The engineer's second look, on demand. */
$('#cadOptimise').onclick = () => {
  if (!job.plan) { log('nothing on the bench to look over', 'err'); return; }
  const found = runOptimiser('bench');
  if (!found.length) log('he looked it over and would not change anything', 'ok');
};

$('#cadFindings').addEventListener('click', e => {
  const b = e.target.closest('[data-fix]');
  if (b) applyOneFinding(Number(b.dataset.fix));
});

$('#cadRun').onclick = () => toggleEngineRun();

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
/* The engine spec is one object, not a part, so it cannot go through
   editPart — but it goes through the same clamp-and-re-solve path, and
   lands on the same undo stack. Changing the bore re-sizes every part that
   came off it, which is the entire point of having a spec at all. */
$('#cadSide').addEventListener('input', e => {
  const k = e.target.dataset.e;
  if (k && job.plan?.engine) {
    if (e.target.value === '') return;
    editEngine({ [k]: Number(e.target.value) });
    return;
  }
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
  if (FIELD_KEYS.has(e.target.dataset.f) || e.target.dataset.e) cad.renderProps(true);
});
$('#cadSide').addEventListener('focusout', () => setTimeout(() => {
  if (!$('#cadSide').contains(document.activeElement)) cad.renderProps(true);
}, 0));
$('#cadSide').addEventListener('click', e => {
  const b = e.target.closest('button[data-cmd]');
  if (b) cad.onCommand(b.dataset.cmd);
});

/* ------------------------------------------------------------------ */
/* the shape editor                                                    */
/* ------------------------------------------------------------------ */
/* The bench owns the drawing and the parsing; saving to disk and telling
   everything else the vocabulary changed is the app's job, so the two are
   split exactly the way every other bench edit is. */
$('#cadShapes').addEventListener('input', e => {
  const k = e.target.dataset.sh;
  if (k === 'pts') cad.editShapeText(e.target.value);
  else if (k === 'id') cad.setShapeField('id', e.target.value);
});

$('#cadShapes').addEventListener('change', e => {
  const k = e.target.dataset.sh;
  if (k === 'kind' || k === 'from') cad.setShapeField(k, e.target.value);
});

$('#cadShapes').addEventListener('click', async e => {
  const b = e.target.closest('button[data-sh]');
  if (!b) return;
  const k = b.dataset.sh;
  if (k === 'close' || k === 'cancel') return cad.closeShapes();
  if (k === 'edit') return cad.openShapes(b.dataset.id);
  if (k === 'drop') {
    await deleteShape(b.dataset.id);
    return;
  }
  if (k === 'save') {
    const draft = cad.shapeEd?.draft;
    if (!draft) return;
    const r = await saveShape(draft);
    if (!r.ok) { cad.shapeEd.error = r.error; cad.renderShapes(); return; }
    /* Made a shape while a part was selected? Then that is the part it was
       being made for — put it on, so the round trip finishes where it
       started rather than leaving somebody to go and find it in a list. */
    if (cad.selected != null && job.plan) {
      editPart(job.plan, cad.selected, { shape: r.shape.id });
      snapshot(`the ${r.shape.id}`);
      reSolve();
    }
    cad.closeShapes();
  }
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
  world.camOrbit.dist = Math.max(5, Math.min(60, world.camOrbit.dist * Math.exp(e.deltaY * 0.0012)));
  // they have picked a framing; stop easing between the wide and close ones
  world.camOrbit.free = true;
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
/* ------------------------------------------------------------------ */
/* the cursor — ⌘K, and everything behind it                           */
/* ------------------------------------------------------------------ */
/* One handler per row in the registry. The registry says what exists and
   what it costs; this says what it does. `wiring.test.mjs` fails if the two
   ever disagree, because an action in the palette with nothing behind it is
   a button that does nothing — which is worse than no button. */
const HANDLERS = {
  'build.run': () => requestBuild(),
  'build.stop': () => stopJob('stopped'),
  'build.again': () => requestBuild({ request: job.request }),
  'build.random': () => {
    const pick = nextProject(studyContext());
    if (!pick) { log('nothing left it has not tried recently', 'err'); return; }
    log(`<b>${JARVIS.name}</b>: ${esc(pick.why)}`, 'hi');
    $('#req').value = pick.request;
    requestBuild({ request: pick.request });
  },

  'bench.toggle': () => toggleCad(),
  'bench.fit': () => cad.frameAll(),
  'bench.look': () => $('#cadOptimise').click(),
  'bench.measure': () => $('#cadMeasure').classList.toggle('on', cad.toggleMeasure()),
  'bench.isolate': () => $('#cadIsolate').classList.toggle('on', cad.toggleIsolate()),
  'bench.section': () => { const on = !cad.section.on; cad.setSection({ on }); $('#cadSectionBtn').classList.toggle('on', on); },
  'bench.add': () => cad.onCommand('add'),
  'bench.shapes': () => { openCad(); cad.onCommand('shapes'); },
  'bench.undo': () => undoEdit(),
  'bench.redo': () => redoEdit(),
  'bench.teach': () => cad.onCommand('teach'),
  'bench.bom': () => $('#cadBom').click(),
  'bench.run': () => toggleEngineRun(),

  'floor.software': () => focusRoom('software'),
  'floor.metal': () => focusRoom('metal'),
  'floor.finished': () => focusRoom('finished'),
  'floor.cardboard': () => focusRoom('cardboard'),
  'floor.electronics': () => focusRoom('electronics'),
  'floor.machining': () => focusRoom('machining'),
  'floor.follow': () => { $('#followCam').checked = true; world.camOrbit.free = false; },
  'floor.wide': () => { $('#followCam').checked = false; world.camOrbit.free = false; world.lookAtRoom('finished'); },

  'export.plan': () => $('#btnExport').click(),
  'export.stl': () => exportModel('stl'),
  'export.obj': () => exportModel('obj'),

  'skills.export': () => $('#btnSkillExport').click(),
  'skills.import': () => $('#btnSkillImport').click(),
  'skills.forget': async () => {
    const n = skills.length;
    skills.length = 0;
    await persistSkills();
    renderSkills();
    log(`forgot ${n} skill${n === 1 ? '' : 's'} — the library is empty`, 'err');
  },

  'study.now': () => beginStudy(true),
  'study.toggle': async () => {
    $('#cfgStudy').checked = !$('#cfgStudy').checked;
    await saveCfg();
    log(`practice when idle: ${study.on ? 'on' : 'off'}`, 'hi');
  },
  'study.plan': () => {
    const r = studyReport(studyContext());
    if (r.weakTrade) log(`weakest trade: <b>${esc(roleById(r.weakTrade.trade)?.name || r.weakTrade.trade)}</b>`, 'err');
    if (r.exhausted) { log('it has tried everything on the syllabus recently', 'hi'); return; }
    log(`<b>syllabus</b> — next: ${esc(r.next.request)}`, 'hi');
    r.queue.slice(0, 6).forEach(q => log(`  ${q.ready ? '·' : '×'} [${q.kind}] ${esc(q.request)} — ${esc(q.why)}`, q.ready ? '' : 'err'));
  },

  'engine.settings': () => { $('#modal').hidden = false; },
  'engine.test': () => { $('#modal').hidden = false; $('#btnProbe').click(); },
  'engine.offline': async () => {
    cfg.chain = [];
    for (const t of TIERS) delete cfg.tiers[t];
    await saveCfg();
    renderProviders(); renderTiers();
    log('working offline — nothing will be sent anywhere', 'hi');
  },

  'app.log': async () => {
    const text = [...logEl.children].map(d => d.textContent).join('\n');
    try { await navigator.clipboard.writeText(text); log('log copied', 'ok'); }
    catch { log('could not reach the clipboard', 'err'); }
  }
};

function runAction(id) {
  const a = actionById(id);
  if (!a) return;
  if (!isAvailable(a, shopState())) { log(`${esc(a.label)} — not right now`, 'err'); return; }
  const fn = HANDLERS[id];
  if (!fn) { log(`nothing is wired to ${esc(id)}`, 'err'); return; }
  try { fn(); } catch (err) { log(`${esc(a.label)} failed: ${esc(err.message)}`, 'err'); }
}

/* The shape of the shop, as the palette needs to see it. Asked fresh every
   time it opens — a palette showing last minute's state is worse than one
   showing none. */
const shopState = () => ({ building: job.running, settled: buildSettled(), bench: cad.active });

const palette = new Palette({
  root: $('#palette'),
  onRun: runAction,
  getState: shopState
});
bindPaletteHotkey(palette);

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
  /* ⌘⏎ and ⌘, work from inside the request box, because that is exactly
     where you are when you want them. */
  if (e.metaKey || e.ctrlKey) {
    const id = actionForKey({ key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, shift: e.shiftKey });
    if (id && ['build.run', 'engine.settings'].includes(id)) { e.preventDefault(); runAction(id); return; }
  }
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
  const k = e.key.toLowerCase();
  if (k === 'b') { toggleCad(); return; }
  // R turns the engine over, on the bench or off it — it is about what is
  // on the pedestal, not about which panel is open
  if (k === 'r') { toggleEngineRun(); return; }
  if (e.key === 'Escape' && cad.active) { closeCad(); return; }

  /* One key per station, and there are six of them now. This used to be
     '1234', which quietly meant the electronics bench had a key printed in
     the palette that did nothing. */
  const n = '123456'.indexOf(e.key);
  if (cad.active) {
    // the number keys switch view, not room, while you are on the bench
    if (n >= 0 && n < CAD_KEY_VIEWS.length) {
      cad.setView(CAD_KEY_VIEWS[n]);
      mark('#cadTools [data-view]', $(`#cadTools [data-view="${CAD_KEY_VIEWS[n]}"]`));
    }
    if (k === 'f') cad.frameAll();
    if (k === 'x') { cad.setMode(cad.mode === 'xray' ? 'shaded' : 'xray'); mark('#cadTools [data-mode]', $(`#cadTools [data-mode="${cad.mode}"]`)); }
    if (k === 'o') $('#cadOptimise').click();
    if (k === 'm') $('#cadMeasure').classList.toggle('on', cad.toggleMeasure());
    if (k === 'i') $('#cadIsolate').classList.toggle('on', cad.toggleIsolate());
    if (k === 's') { const on = !cad.section.on; cad.setSection({ on }); $('#cadSectionBtn').classList.toggle('on', on); }
    return;
  }
  if (n >= 0) focusRoom(ROOM_ORDER[n]);
  if (k === 'f') { $('#followCam').checked = true; world.camOrbit.free = false; }
});

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */
/* Everything the settings sheet is editing, held here because the engine
   half of it is generated rather than written out in the markup. Nine
   providers × three fields is not something to hand-write, and the moment a
   tenth is added the panel would go stale. */
let cfg = { providers: {}, chain: [], tiers: {} };

async function loadCfg() {
  const c = await window.forge.getCfg();
  cfg = { providers: c.providers || {}, chain: c.chain || [], tiers: c.tiers || {} };
  $('#cfgReferences').value = c.references || 'auto';
  $('#cfgThingiverse').value = c.thingiverseToken || '';
  $('#cfgSearx').value = c.searxBase || '';
  $('#cfgReadPages').checked = c.readPages !== false;
  $('#cfgStudy').checked = !!c.study;
  $('#cfgStudyEngine').checked = !!c.studyEngine;
  study.on = !!c.study;
  study.engine = !!c.studyEngine;
  renderProviders();
  renderTiers();
  setStudyBadge();
  setEngineChainBadge();
}

async function saveCfg() {
  await window.forge.setCfg({
    providers: cfg.providers,
    chain: cfg.chain,
    tiers: cfg.tiers,
    references: $('#cfgReferences').value,
    thingiverseToken: $('#cfgThingiverse').value.trim(),
    searxBase: $('#cfgSearx').value.trim(),
    readPages: $('#cfgReadPages').checked,
    study: $('#cfgStudy').checked,
    studyEngine: $('#cfgStudyEngine').checked
  });
  study.on = $('#cfgStudy').checked;
  study.engine = $('#cfgStudyEngine').checked;
  if (!study.on && study.running) interrupt();
  setStudyBadge();
  setEngineChainBadge();
}

/* One row per engine: a tick to put it in the chain, a key, a model and a
   base. The row shows what the provider is FOR rather than only what it is
   called — "the fastest thing on the list", "needs no key" — because the
   question somebody actually has open in front of this panel is which one
   to bother setting up. */
function renderProviders() {
  const host = $('#providerList');
  if (!host) return;
  host.innerHTML = '';
  for (const p of PROVIDERS) {
    const pc = cfg.providers[p.id] = cfg.providers[p.id] || { key: '', model: p.defaultModel, base: '' };
    const on = cfg.chain.includes(p.id);
    const row = document.createElement('div');
    row.className = 'provRow' + (on ? ' on' : '');
    row.innerHTML = `
      <label class="provHead">
        <input type="checkbox" data-prov="${p.id}" data-field="use" ${on ? 'checked' : ''}>
        <b>${esc(p.label)}</b>
        <span class="provTag">${p.needsKey ? 'needs a key' : 'no key needed'}</span>
        ${p.keyUrl ? `<a href="#" data-url="${esc(p.keyUrl)}" class="provKeyLink">get one</a>` : ''}
      </label>
      <div class="provFields">
        ${p.needsKey ? `<input type="password" data-prov="${p.id}" data-field="key" placeholder="${esc(p.keyHint || 'API key')}" value="${esc(pc.key || '')}" spellcheck="false">` : ''}
        <input type="text" data-prov="${p.id}" data-field="model" list="models-${p.id}" placeholder="model" value="${esc(pc.model || '')}" spellcheck="false">
        <datalist id="models-${p.id}">${(p.models || []).map(m => `<option value="${esc(m)}">`).join('')}</datalist>
        <input type="text" data-prov="${p.id}" data-field="base" placeholder="${esc(p.base || 'https://your-endpoint/v1')}" value="${esc(pc.base || '')}" spellcheck="false">
        <button type="button" data-prov="${p.id}" data-field="list" class="provList1">models</button>
      </div>
      ${p.note ? `<p class="fine provNote">${esc(p.note)}</p>` : ''}`;
    host.appendChild(row);
  }
  host.querySelectorAll('[data-url]').forEach(a => a.onclick = e => { e.preventDefault(); window.forge.openUrl(a.dataset.url); });
}

/* Which engine does which KIND of job. Unset falls up, which is why the
   first option in every list says so rather than being blank. */
function renderTiers() {
  const host = $('#tierRows');
  if (!host) return;
  const usable = usableChain(cfg);
  host.innerHTML = '';
  for (const t of TIERS) {
    const a = cfg.tiers[t] || {};
    const row = document.createElement('div');
    row.className = 'tierRow';
    row.innerHTML = `
      <div class="tierWho"><b>${esc(t)}</b><span>${esc(TIER_LABEL[t])}</span></div>
      <select data-tier="${t}">
        <option value="">— fall up to the next one —</option>
        ${usable.map(id => `<option value="${id}"${a.provider === id ? ' selected' : ''}>${esc(providerById(id).label)}</option>`).join('')}
      </select>
      <input type="text" data-tier="${t}" data-field="model" placeholder="same model as above" value="${esc(a.model || '')}" spellcheck="false">`;
    host.appendChild(row);
  }
}

/* The engine badge with nothing running: what the shop WOULD use. */
function setEngineChainBadge() {
  const usable = usableChain(cfg);
  if (job.running) return;
  if (!usable.length) { setEngine('offline planner', 'offline'); return; }
  setEngine(`${providerById(usable[0]).label}${usable.length > 1 ? ` +${usable.length - 1}` : ''}`, 'nim');
}

/* Every field in the generated engine panel goes through here. Delegated
   rather than bound per input, because the panel is redrawn whenever the
   chain changes and per-input handlers would go with it. */
$('#modal').addEventListener('change', async e => {
  const el = e.target;
  const id = el.dataset.prov;
  if (id) {
    const pc = cfg.providers[id] = cfg.providers[id] || { key: '', model: '', base: '' };
    if (el.dataset.field === 'use') {
      cfg.chain = el.checked
        ? [...cfg.chain.filter(x => x !== id), id].sort((a, b) => PROVIDERS.findIndex(p => p.id === a) - PROVIDERS.findIndex(p => p.id === b))
        : cfg.chain.filter(x => x !== id);
      /* A tier pointing at an engine that just left the chain is a tier that
         silently does nothing, so it is cleared rather than left dangling. */
      for (const t of TIERS) if (cfg.tiers[t]?.provider === id && !cfg.chain.includes(id)) delete cfg.tiers[t];
      renderProviders(); renderTiers();
    } else if (['key', 'model', 'base'].includes(el.dataset.field)) {
      pc[el.dataset.field] = el.value.trim();
      if (el.dataset.field === 'key') renderTiers();
    }
    await saveCfg();
    return;
  }
  const tier = el.dataset.tier;
  if (tier) {
    const cur = cfg.tiers[tier] || {};
    if (el.dataset.field === 'model') cur.model = el.value.trim();
    else cur.provider = el.value;
    if (!cur.provider) delete cfg.tiers[tier]; else cfg.tiers[tier] = cur;
    await saveCfg();
    return;
  }
  if (el.id?.startsWith('cfg')) await saveCfg();
});

/* Ask a provider what it can actually reach today, rather than offering a
   hardcoded guess that goes stale. */
$('#modal').addEventListener('click', async e => {
  const btn = e.target.closest('button[data-field="list"]');
  if (!btn) return;
  const id = btn.dataset.prov;
  btn.textContent = '…';
  const r = await window.forge.models(id);
  btn.textContent = 'models';
  const dl = $(`#models-${id}`);
  if (dl && r.models?.length) {
    dl.innerHTML = r.models.map(m => `<option value="${esc(m)}">`).join('');
    log(`${providerById(id).label}: ${r.models.length} model${r.models.length === 1 ? '' : 's'} reachable`, r.ok ? 'ok' : 'err');
  } else {
    log(`${providerById(id).label}: ${esc(r.error || 'no models came back')}`, 'err');
  }
});

$('#btnSettings').onclick = () => $('#modal').hidden = false;
$('#btnCloseModal').onclick = async () => { await saveCfg(); $('#modal').hidden = true; };
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') $('#btnCloseModal').click(); });
document.querySelectorAll('[data-url]').forEach(a => a.onclick = e => { e.preventDefault(); window.forge.openUrl(a.dataset.url); });

$('#btnProbe').onclick = async () => {
  await saveCfg();
  $('#probeOut').textContent = 'testing…';
  const r = await window.forge.probe();
  const lines = [];
  /* Everything set up, with the CLASSIFIED reason when it did not answer.
     "auth" and "network" are two very different afternoons and the old
     panel reported both as an HTTP number. */
  for (const p of PROVIDERS) {
    const s = r.providers?.[p.id];
    if (!s || s.code === 'unset') continue;
    lines.push(s.ok
      ? `${p.label.padEnd(22)} ok — ${s.models.length} model${s.models.length === 1 ? '' : 's'}`
      : `${p.label.padEnd(22)} ${s.error}`);
    if (s.ok) {
      const dl = $(`#models-${p.id}`);
      if (dl) dl.innerHTML = s.models.map(m => `<option value="${esc(m)}">`).join('');
    }
  }
  if (!lines.length) lines.push('No engine is set up. Tick one above and give it a key — or leave it, and the shop builds offline from what it knows.');
  if (r.web?.ok) lines.push(`${'Web search'.padEnd(22)} ok — ${r.web.count} results, e.g. "${String(r.web.first).slice(0, 50)}"`);
  else lines.push(`${'Web search'.padEnd(22)} ${r.web?.error}`);
  if (r.refs?.ok) lines.push(`${'Reference designs'.padEnd(22)} ok — ${r.refs.found} found`);
  else lines.push(`${'Reference designs'.padEnd(22)} ${r.refs?.error || 'nothing came back'}`);
  $('#probeOut').textContent = lines.join('\n');
  renderTiers();
  setEngineChainBadge();
};

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

$('#btnBuild').onclick = () => { interrupt(); requestBuild(); };

/* Study time ends the moment the person does anything at all. Being shy
   about this is what makes an app that animates while you are reading it. */
for (const ev of ['pointerdown', 'keydown', 'wheel']) {
  window.addEventListener(ev, interrupt, { capture: true, passive: true });
}
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
/* The crew panel is redrawn a few times a second rather than every frame —
   it is five rows of text and rebuilding it at 60fps is pure waste. */
let crewDirty = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now; T += dt;

  crew.tick(dt, T);
  if (!crew.running) idleTick(dt);
  crew.update(dt);
  world.tick(T, dt);
  if (crewDirty > 0.25) { crewDirty = 0; renderCrew(); } else crewDirty += dt;

  /* With six robots there is no "him" to follow. The camera follows
     whoever is doing the most interesting thing, and cuts to the pedestal
     while parts are going down — a wide shot of an empty walkway is what
     you get if you just average their positions. */
  const star = focusBot();
  /* Follow one robot while there is work on the floor. With nothing on, go
     wide and frame the shop — a five-trade floor standing idle, shot at 16
     metres over one robot's shoulder, looks exactly like the one-robot shop
     it replaced. */
  const star2 = crew.running ? star : null;
  let follow = ($('#followCam').checked && star2) ? tmp.copy(star2.pos) : null;
  if (follow && star.phase === 'work' && star.step) {
    const b = ROOMS[star.step.step.room].bench;
    follow.x = follow.x * 0.4 + b[0] * 0.6;
    follow.z = follow.z * 0.4 + (b[1] + 0.35) * 0.6;
  }
  if (follow && crew.haul?.stage === 'place') {
    follow.x = follow.x * 0.35 + ROOMS.finished.x * 0.65;
    follow.z = follow.z * 0.35 + PEDESTAL_Z * 0.65;
  }
  world.updateCamera(dt, follow);

  if (follow) {
    let nearest = ROOM_ORDER[0], best = 1e9;
    for (const k of ROOM_ORDER) {
      const d = Math.abs(ROOMS[k].x - star.pos.x);
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
  await loadShapes();
  await loadSkills();
  log(`floor open — one bay, ${CREW.length} on the crew, ${CLIPS.length} animations loaded`, 'hi');
  log(`${CREW.map(r => `<b>${r.name}</b> (${r.trade.toLowerCase()})`).join(', ')}`, 'hi');
  renderCrew();
  world.lookAtRoom('finished');
  if (skills.length) log(`${skills.length} skill${skills.length === 1 ? '' : 's'} on file — ${skills.map(s => s.class).join(', ')}`, 'hi');
  if (myShapes.length) log(`${myShapes.length} shape${myShapes.length === 1 ? '' : 's'} of your own — ${myShapes.map(s => s.id).join(', ')}`, 'hi');
  const r = await window.forge.probe();
  const up = PROVIDERS.filter(p => r.providers?.[p.id]?.ok);
  const set = PROVIDERS.filter(p => r.providers?.[p.id] && r.providers[p.id].code !== 'unset');
  if (up.length) {
    setEngineChainBadge();
    log(`${up.length} engine${up.length === 1 ? '' : 's'} reachable — ${up.map(p => esc(p.label)).join(', ')}`, 'ok');
    for (const p of set.filter(x => !r.providers[x.id].ok)) {
      log(`${esc(p.label)}: ${esc(r.providers[p.id].error)}`, 'err');
    }
  } else if (set.length) {
    setEngine('offline planner', 'offline');
    set.forEach(p => log(`${esc(p.label)}: ${esc(r.providers[p.id].error)}`, 'err'));
    log('nothing answered — the shop will build offline from what it knows', 'err');
  } else {
    setEngine('offline planner', 'offline');
    log('no engine set up — press <b>⌘K</b> and type "api key", or run Ollama and tick it', 'err');
  }
  /* Which engine is doing which job, once, so it is not a surprise later. */
  for (const t of TIERS) {
    const a = cfg.tiers[t];
    if (a?.provider) log(`${t}: ${esc(engineLabel(a.provider, a.model))}`, 'hi');
  }
  crew.foreman.play('wave');
  caption('waving', 'Tell me what to build.');
  requestAnimationFrame(frame);
})();
