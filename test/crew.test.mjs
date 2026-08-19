/* The crew.

   What is being defended here is THE MERGE. Four specialists work at the
   same time, each numbering its own parts from zero and each referring to
   the frame only by mount name. None of that is wrong until it is put
   together — and a renumbering bug does not throw, it silently bolts the
   shade to a wheel and the object still solves, still renders, and is
   quietly the wrong object. That is the same failure class as
   reindexAttachments in agent.js, so it is defended the same way: by
   asserting on indices, not on the fact that nothing crashed.

   Second thing being defended is the AUTHORITY ENVELOPE. A specialist's
   materials are a hard boundary. The electrical specialist coming back with
   a cardboard chassis is not a style choice — it is a load-bearing part made
   by someone who does not make load-bearing parts, and letting one through
   would put a corrugated leg under a weldment.

   Third is that NOTHING STOPS THE FLOOR. The manager's call failing, one
   specialist failing, every call failing, and a specialist coming back with
   an empty parts list are all separately exercised, and every one of them
   still has to produce a solvable object.

     node test/crew.test.mjs
*/
import {
  SPECIALISTS, CREW, ROLE_IDS, SPECIALIST_IDS, FOREMAN, JARVIS, STATIONS,
  roleById, roleForMaterial, roleForStation, stationOf, actionFor,
  clampMaterial, clampShape, budgetOf, makesParts, formatRoster, roleBlock
} from '../renderer/roles.js';
import {
  ORDER_SCHEMA, validateOrder, orderFromParts, buildOrderMessages, describeOrder,
  orderExpectations, FRAME_MAX, MOUNT_MAX
} from '../renderer/workorder.js';
import {
  validateSubplan, validateSpec, mergeSubplans, fallbackSubplan, attributePlan,
  buildSpecialistMessages, buildControlsMessages, crewTally, SUBPLAN_SCHEMA
} from '../renderer/crewplan.js';
import { ShopFloor, Ledger, gateAssignment, jarvisReport, parseJSON } from '../renderer/shopfloor.js';
import { validatePlan, planParts, offlinePlan } from '../renderer/agent.js';
import { MOVERS } from '../renderer/catalog.js';
import { solveAssembly, MATERIALS, SHAPES } from '../renderer/assembly.js';
import { inspectPlan } from '../renderer/critic.js';
import { netlist, analyseCircuit } from '../renderer/circuit.js';

let pass = 0, fail = 0;
const out = [];
const check = (name, fn) => {
  try { fn(); pass++; out.push(`  ok    ${name}`); }
  catch (e) { fail++; out.push(`  FAIL  ${name}\n          ${e.message}`); }
};
const acheck = async (name, fn) => {
  try { await fn(); pass++; out.push(`  ok    ${name}`); }
  catch (e) { fail++; out.push(`  FAIL  ${name}\n          ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

/* A work order the tests can lean on: a base, a mast bolted to it, and two
   mounts. Small on purpose — the manager's job is the skeleton. */
const ORDER = validateOrder({
  title: 'desk lamp',
  summary: 'a lamp',
  requirements: ['stands on its own'],
  frame: [
    { name: 'base', shape: 'cylinder', material: 'metal', size: [0.5, 0.12, 0.5] },
    { name: 'mast', shape: 'rod', material: 'metal', size: [0.14, 0.8, 0.14], attach: { to: 0, face: 'top' } }
  ],
  mounts: [
    { id: 'mast_top', on: 1, face: 'top', note: 'the shade goes here' },
    { id: 'base_side', on: 0, face: 'left' }
  ],
  assignments: [
    { role: 'softgoods', mount: 'mast_top', parts: 2, brief: 'the shade', must: ['shade'] },
    { role: 'electrical', mount: 'base_side', parts: 3, brief: 'the lamp circuit', must: ['lamp'] }
  ]
}, 'desk lamp');

/* ------------------------------------------------------------------ */
/* the register                                                        */
/* ------------------------------------------------------------------ */
check('every trade on the floor is complete and consistent', () => {
  assert(SPECIALISTS.length >= 4, `only ${SPECIALISTS.length} specialists`);
  for (const r of CREW) {
    assert(r.id && r.name && r.trade, `${r.id} is missing a name or a trade`);
    assert(r.description.length > 80, `${r.id} has no real description to prompt with`);
    assert(Array.isArray(r.responsibilities) && r.responsibilities.length, `${r.id} has no responsibilities`);
    assert(Number.isInteger(r.authority) && r.authority >= 1 && r.authority <= 10, `${r.id} authority ${r.authority} is out of range`);
    assert(!r.station || STATIONS.includes(r.station), `${r.id} works at "${r.station}", which is not a station`);
    for (const m of r.materials) assert(MATERIALS.includes(m), `${r.id} claims material "${m}", which the solver does not have`);
    for (const s of r.shapes) assert(SHAPES.includes(s), `${r.id} claims shape "${s}", which the solver cannot draw`);
  }
  assert(new Set(ROLE_IDS).size === ROLE_IDS.length, 'two trades share an id');
  assert(JARVIS.authority > FOREMAN.authority, 'the foreman outranks Jarvis');
  for (const r of SPECIALISTS) assert(FOREMAN.authority > r.authority, `${r.id} outranks the foreman`);
});

check('every station on the floor has somebody standing at it', () => {
  for (const s of STATIONS) {
    const who = CREW.find(r => r.station === s);
    assert(who, `nobody works at the ${s} station — a step there would never be picked up`);
  }
  // and nobody shares one, or two robots walk to the same bench
  const seen = new Set();
  for (const r of CREW) {
    if (!r.station) continue;
    assert(!seen.has(r.station), `two trades are stationed at ${r.station}`);
    seen.add(r.station);
  }
});

check('every material the solver has lands on exactly one trade', () => {
  for (const m of MATERIALS) {
    const owner = roleForMaterial(m);
    assert(roleById(owner), `"${m}" routes to "${owner}", who does not work here`);
    const claim = SPECIALISTS.filter(r => r.owns.includes(m));
    assert(claim.length <= 1, `${m} is owned by ${claim.map(r => r.id).join(' and ')} — routing is ambiguous`);
  }
  // metal is structural, cardboard is not — the two rules the floor turns on
  assert(roleForMaterial('metal') === 'structures', 'metal does not go to structures');
  assert(roleForMaterial('cardboard') === 'softgoods', 'cardboard does not go to light materials');
});

check('a trade cannot be talked into a material it does not work in', () => {
  assert(clampMaterial('electrical', 'cardboard') !== 'cardboard', 'the electrical specialist accepted cardboard');
  assert(clampMaterial('softgoods', 'metal') !== 'metal', 'light materials accepted metal');
  assert(clampMaterial('structures', 'metal') === 'metal', 'structures was refused its own material');
  // and the coercion always lands somewhere the solver understands
  for (const r of SPECIALISTS) {
    if (!r.materials.length) continue;
    assert(MATERIALS.includes(clampMaterial(r.id, 'nonsense')), `${r.id} coerces to a material that does not exist`);
    assert(SHAPES.includes(clampShape(r.id, 'nonsense')), `${r.id} coerces to a shape nothing can draw`);
  }
});

check('the trade that makes no parts is never given a parts budget', () => {
  assert(!makesParts('controls'), 'controls is expected to produce geometry');
  assert(budgetOf('controls', 5) === 0, 'controls was given a budget');
  const gate = gateAssignment({ role: 'controls', parts: 3 });
  assert(!gate.ok, 'the authority gate let controls be assigned parts');
  assert(gateAssignment({ role: 'structures', parts: 3 }).ok, 'structures was refused normal work');
  assert(!gateAssignment({ role: 'nobody', parts: 1 }).ok, 'a trade that does not exist was allowed');
  assert(!gateAssignment({ role: 'structures', parts: 99 }).ok, 'a wildly over-budget assignment was allowed');
});

check('every action a trade plays is one its station actually has a clip for', () => {
  // the clip's own room wins in validatePlan, so an action from the wrong
  // station silently relocates the step and the robot walks somewhere else
  for (const r of CREW) {
    for (const kind of Object.keys(r.actions)) {
      const a = actionFor(r.id, kind);
      assert(typeof a === 'string' && a.length, `${r.id}.${kind} has no action`);
    }
  }
  assert(stationOf('structures') === 'metal', 'structures is not at the metal station');
  assert(stationOf('nobody') === 'finished', 'an unknown trade does not fall through to the foreman');
  assert(roleForStation('electronics') === 'electrical', 'the electronics station has the wrong owner');
});

check('the roster the manager is handed names everybody and their limits', () => {
  const text = formatRoster();
  for (const r of SPECIALISTS) {
    assert(text.includes(r.id), `the roster does not mention ${r.id}`);
    assert(text.includes(r.trade), `the roster does not say what ${r.id} does`);
  }
  assert(/controls/.test(text) && /requirements only/.test(text),
    'the roster does not tell the manager that controls makes no parts');
  for (const r of SPECIALISTS) {
    const b = roleBlock(r.id);
    assert(b.includes('YOUR MATERIALS'), `${r.id}'s prompt block does not state its materials`);
    assert(r.vocabulary.every(v => b.includes(v)), `${r.id}'s vocabulary does not reach its prompt`);
  }
});

/* ------------------------------------------------------------------ */
/* the work order                                                      */
/* ------------------------------------------------------------------ */
check('a work order is mergeable whatever the manager said', () => {
  const junk = validateOrder({
    title: 'x'.repeat(400),
    frame: Array.from({ length: 20 }, (_, i) => ({ name: `f${i}`, shape: 'nope', material: 'unobtanium', size: [99, -3, 'x'], attach: { to: 19, face: 'sideways' } })),
    mounts: [
      { id: 'A Mount!', on: 0, face: 'top' },
      { id: 'a_mount', on: 0, face: 'top' },          // same slug — one of them goes
      { id: 'off_frame', on: 99, face: 'top' },       // points at nothing
      { id: 'bad_face', on: 0, face: 'diagonal' }
    ],
    assignments: [
      { role: 'structures', parts: 99, brief: 'everything' },
      { role: 'structures', parts: 2, brief: 'everything again' },   // duplicate trade
      { role: 'nobody', parts: 2, brief: 'x' },
      { role: 'controls', parts: 4, brief: 'x' }
    ]
  }, 'junk');

  assert(junk.frame.length <= FRAME_MAX, `frame ran to ${junk.frame.length}`);
  assert(!junk.frame[0].attach, 'the part that stands on the pedestal is attached to something');
  junk.frame.forEach((p, i) => {
    assert(!p.attach || p.attach.to < i, `frame part ${i} attaches forward to ${p.attach?.to}`);
    assert(SHAPES.includes(p.shape) && MATERIALS.includes(p.material), `frame part ${i} kept a shape or material that does not exist`);
    assert(p.size.every(v => v >= 0.15 && v <= 2.5), `frame part ${i} size ${p.size} is out of range`);
  });
  assert(junk.mounts.length <= MOUNT_MAX + 2, 'mounts are unbounded');
  for (const m of junk.mounts) assert(m.on >= 0 && m.on < junk.frame.length, `mount ${m.id} points at frame part ${m.on}`);
  assert(new Set(junk.mounts.map(m => m.id)).size === junk.mounts.length, 'two mounts share an id');

  const roles = junk.assignments.map(a => a.role);
  assert(new Set(roles).size === roles.length, 'a trade was assigned twice');
  assert(roles.every(r => SPECIALIST_IDS.includes(r)), `an assignment names ${roles.filter(r => !SPECIALIST_IDS.includes(r))}`);
  assert(junk.assignments.find(a => a.role === 'structures').parts <= roleById('structures').budget[1], 'over budget got through');
  assert(junk.assignments.find(a => a.role === 'controls').parts === 0, 'controls kept a parts budget');
  for (const a of junk.assignments) assert(junk.mounts.some(m => m.id === a.mount), `${a.role} points at a mount that does not exist`);
});

check('an empty order still comes back buildable', () => {
  const o = validateOrder({}, 'a thing');
  assert(o.frame.length === 1, 'an empty order produced no frame');
  assert(o.mounts.length >= 1, 'an empty order produced no mounts');
  assert(o.assignments.some(a => a.parts > 0), 'an empty order gave nobody any work — that is a frame, not an object');
});

check('the floor can decompose a plan it was handed, with no model at all', () => {
  const plan = validatePlan(offlinePlan('a desk lamp', null), 'a desk lamp');
  const order = orderFromParts(planParts(plan), 'a desk lamp');
  assert(order.frame.length >= 1 && order.frame.length <= FRAME_MAX, `frame of ${order.frame.length}`);
  assert(!order.frame[0].attach, 'the offline frame does not stand on anything');
  assert(order.assignments.length >= 1, 'nobody got any work out of the offline split');
  for (const a of order.assignments) {
    assert(makesParts(a.role), `${a.role} was assigned parts and makes none`);
    assert(order.mounts.some(m => m.id === a.mount), `${a.role}'s mount does not exist`);
  }
  assert(/frame of/.test(describeOrder(order)), 'the order does not describe itself');
});

/* ------------------------------------------------------------------ */
/* what a specialist hands back                                        */
/* ------------------------------------------------------------------ */
check('a specialist cannot deliver outside its own materials or budget', () => {
  const sub = validateSubplan({
    parts: [
      { name: 'shade', shape: 'cone', material: 'cardboard', size: [0.4, 0.3, 0.4], mount: 'mast_top' },
      { name: 'steel bracket', shape: 'box', material: 'metal', size: [0.3, 0.1, 0.3], mount: 'mast_top' },
      { name: 'over budget', shape: 'box', material: 'wood', size: [0.2, 0.2, 0.2], mount: 'mast_top' },
      { name: 'also over', shape: 'box', material: 'wood', size: [0.2, 0.2, 0.2], mount: 'mast_top' }
    ]
  }, 'softgoods', ORDER, { role: 'softgoods', mount: 'mast_top', parts: 2 });

  assert(sub.parts.length === 2, `budget of 2 produced ${sub.parts.length} parts`);
  assert(sub.dropped === 2, `${sub.dropped} dropped, expected 2`);
  assert(sub.parts[1].material !== 'metal', 'light materials delivered a metal part');
  assert(sub.coerced >= 1, 'the coercion was not counted');
  for (const p of sub.parts) {
    assert(roleById('softgoods').materials.includes(p.material), `delivered ${p.material}`);
    assert(roleById('softgoods').shapes.includes(p.shape), `delivered a ${p.shape}`);
  }
});

check('a specialist can only point at a mount that exists, or at its own earlier parts', () => {
  const sub = validateSubplan({
    parts: [
      { name: 'a', shape: 'cone', material: 'cardboard', size: [0.4, 0.3, 0.4], mount: 'nowhere' },
      { name: 'b', shape: 'panel', material: 'cardboard', size: [0.3, 0.1, 0.3], attach: { to: 0, face: 'top' } },
      { name: 'c', shape: 'box', material: 'cardboard', size: [0.2, 0.2, 0.2], attach: { to: 9, face: 'top' } }
    ]
  }, 'softgoods', ORDER, { role: 'softgoods', mount: 'mast_top', parts: 6 });

  assert(sub.parts[0].mount === 'mast_top', 'an unknown mount was not pulled back to the assigned one');
  assert(sub.parts[1].attach.to === 0, 'a valid local attachment was lost');
  assert(!sub.parts[2].attach, 'an attachment to a part that does not exist survived');
  assert(sub.parts[2].mount, 'a part with a broken attachment was left with nowhere to go');
  // a forward reference is the one that would reparent half the object
  const fwd = validateSubplan({
    parts: [
      { name: 'a', shape: 'cone', material: 'cardboard', size: [0.4, 0.3, 0.4], attach: { to: 1, face: 'top' } },
      { name: 'b', shape: 'panel', material: 'cardboard', size: [0.3, 0.1, 0.3], mount: 'mast_top' }
    ]
  }, 'softgoods', ORDER, { role: 'softgoods', mount: 'mast_top', parts: 4 });
  assert(!fwd.parts[0].attach, 'a forward reference survived validation');
});

check('a component keeps the body the catalogue says it has', () => {
  const sub = validateSubplan({
    parts: [{ name: 'r', shape: 'box', material: 'cardboard', size: [2.5, 2.5, 2.5], component: 'resistor', value: 470, mount: 'base_side' }]
  }, 'electrical', ORDER, { role: 'electrical', mount: 'base_side', parts: 2 });
  const p = sub.parts[0];
  assert(p.component === 'resistor', 'the component was lost');
  assert(p.material === 'plastic', `a resistor came out in ${p.material}`);
  assert(p.size[0] < 0.5, `a resistor came out ${p.size[0]}m across`);
  assert(p.value === 470, 'the value was thrown away');
});

check('controls cannot smuggle geometry in', () => {
  const spec = validateSpec({
    requirements: ['stands up', '', 'x'.repeat(500)],
    checks: ['shade clears the stem'],
    parts: [{ name: 'sneaky', shape: 'box', material: 'metal', size: [1, 1, 1] }]
  });
  assert(spec.parts.length === 0, 'controls delivered parts');
  assert(spec.requirements.length === 2, `kept ${spec.requirements.length} requirements`);
  assert(spec.requirements[1].length <= 120, 'a requirement was not truncated');
});

/* ------------------------------------------------------------------ */
/* THE MERGE                                                           */
/* ------------------------------------------------------------------ */
check('four trades working at once merge into one object, correctly numbered', () => {
  const soft = validateSubplan({
    parts: [
      { name: 'shade', shape: 'cone', material: 'cardboard', size: [0.44, 0.3, 0.44], mount: 'mast_top' },
      { name: 'collar', shape: 'cylinder', material: 'plastic', size: [0.18, 0.08, 0.18], attach: { to: 0, face: 'bottom' } }
    ]
  }, 'softgoods', ORDER, { role: 'softgoods', mount: 'mast_top', parts: 2 });

  const elec = validateSubplan({
    parts: [
      { name: 'board', component: 'board', shape: 'panel', material: 'plastic', size: [0.4, 0.05, 0.3], mount: 'base_side' },
      { name: 'battery', component: 'battery', shape: 'box', material: 'plastic', size: [0.2, 0.2, 0.2], attach: { to: 0, face: 'top' } },
      { name: 'lamp', component: 'lamp', shape: 'sphere', material: 'glass', size: [0.2, 0.2, 0.2], attach: { to: 0, face: 'top', dx: 0.2 } }
    ],
    wires: [{ from: '1.+', to: '2.a' }, { from: '2.b', to: '1.-' }]
  }, 'electrical', ORDER, { role: 'electrical', mount: 'base_side', parts: 3 });

  const merged = mergeSubplans(ORDER, [soft, elec, validateSpec({ requirements: ['stands up'], checks: ['shade clears'] })]);
  const parts = planParts(merged);

  // frame first, then each trade's block in crew order
  assert(parts[0].name === 'base' && parts[1].name === 'mast', `the frame is not first: ${parts.map(p => p.name).join(', ')}`);
  const iShade = parts.findIndex(p => p.name === 'shade');
  const iCollar = parts.findIndex(p => p.name === 'collar');
  const iBoard = parts.findIndex(p => p.name === 'board');
  const iBattery = parts.findIndex(p => p.name === 'battery');
  const iLamp = parts.findIndex(p => p.name === 'lamp');
  assert(iShade === 2 && iCollar === 3, `light materials landed at ${iShade}, ${iCollar}`);
  assert(iBoard === 4 && iBattery === 5 && iLamp === 6, `electrical landed at ${iBoard}, ${iBattery}, ${iLamp}`);

  // the mount resolved to the real frame part it names
  assert(parts[iShade].attach.to === 1 && parts[iShade].attach.face === 'top',
    `the shade bolted to part ${parts[iShade].attach.to} instead of the mast`);
  assert(parts[iBoard].attach.to === 0 && parts[iBoard].attach.face === 'left',
    `the board bolted to part ${parts[iBoard].attach.to} ${parts[iBoard].attach.face} instead of the base's left`);

  // THE ONE THAT MATTERS: a local attachment shifted by its block's offset
  assert(parts[iCollar].attach.to === iShade,
    `the collar bolted to part ${parts[iCollar].attach.to} — it was supposed to hang off the shade at ${iShade}`);
  assert(parts[iBattery].attach.to === iBoard,
    `the battery bolted to part ${parts[iBattery].attach.to} — it was supposed to sit on the board at ${iBoard}`);
  assert(parts[iLamp].attach.to === iBoard && parts[iLamp].attach.dx === 0.2,
    'the lamp lost its parent or its nudge');

  // and every attachment still points backwards, which is what makes cycles impossible
  parts.forEach((p, i) => assert(!p.attach || p.attach.to < i, `part ${i} (${p.name}) attaches forward to ${p.attach?.to}`));

  // wires were shifted into global pin space with the parts
  assert(merged.wires.length === 2, `${merged.wires.length} wires survived`);
  assert(merged.wires[0].from === `${iBattery}.+`, `wire pin ${merged.wires[0].from}, expected ${iBattery}.+`);
  assert(merged.wires[1].to === `${iBattery}.-`, `wire pin ${merged.wires[1].to}, expected ${iBattery}.-`);

  // every step belongs to somebody, and to the right somebody
  for (const s of merged.steps) assert(ROLE_IDS.includes(s.by), `a step is owned by "${s.by}"`);
  assert(merged.steps.find(s => s.part?.name === 'shade').by === 'softgoods', 'the shade was not made by light materials');
  assert(merged.steps.find(s => s.part?.name === 'board').by === 'electrical', 'the board was not made by the electrical specialist');
  assert(merged.steps.find(s => s.part?.name === 'base').by === 'structures', 'the frame was not made by structures');
  assert(merged.steps.at(-1).action === 'present' && merged.steps.at(-1).by === 'foreman',
    'somebody other than the foreman handed the job over');
});

check('the merged plan survives the same validator a single-model plan does', () => {
  const soft = fallbackSubplan('softgoods', ORDER, { role: 'softgoods', mount: 'mast_top', parts: 3 });
  const str = fallbackSubplan('structures', ORDER, { role: 'structures', mount: 'base_side', parts: 2 });
  const merged = mergeSubplans(ORDER, [str, soft]);
  const validated = validatePlan(merged, 'desk lamp');

  assert(validated.steps.length >= merged.steps.length - 1, 'validatePlan threw most of the merged plan away');
  const parts = planParts(validated);
  parts.forEach((p, i) => assert(!p.attach || p.attach.to < i, `part ${i} attaches forward after validation`));
  // the owner tags survive — without them no robot is scheduled for the step
  assert(validated.steps.every(s => ROLE_IDS.includes(s.by)), 'validatePlan stripped the step owners');

  const solved = solveAssembly(parts);
  assert(solved.instances.length >= parts.length, 'the merged plan does not solve');
  const lowest = Math.min(...solved.instances.map(i => i.pos[1] - i.half[1]));
  assert(Math.abs(lowest) < 0.05, `the merged assembly floats ${lowest.toFixed(3)}m off the pedestal`);
});

check('a trade that delivers nothing leaves a hole nobody else fills', () => {
  const merged = mergeSubplans(ORDER, [
    validateSubplan({ parts: [] }, 'softgoods', ORDER, { role: 'softgoods', mount: 'mast_top', parts: 2 })
  ]);
  const parts = planParts(merged);
  assert(parts.length === ORDER.frame.length, `the frame alone should be ${ORDER.frame.length} parts, got ${parts.length}`);
  assert(merged.steps.at(-1).action === 'present', 'the job never got handed over');
});

check('a fallback subassembly is sized off the frame, not off nothing', () => {
  const big = validateOrder({
    title: 'big', frame: [{ name: 'deck', shape: 'panel', material: 'metal', size: [2.4, 0.2, 2.0] }],
    mounts: [{ id: 'deck_top', on: 0, face: 'top' }], assignments: []
  }, 'big');
  const small = validateOrder({
    title: 'small', frame: [{ name: 'puck', shape: 'cylinder', material: 'metal', size: [0.3, 0.1, 0.3] }],
    mounts: [{ id: 'puck_top', on: 0, face: 'top' }], assignments: []
  }, 'small');

  const a = fallbackSubplan('softgoods', big, { role: 'softgoods', mount: 'deck_top', parts: 2 });
  const b = fallbackSubplan('softgoods', small, { role: 'softgoods', mount: 'puck_top', parts: 2 });
  assert(a.parts[0].size[0] > b.parts[0].size[0] * 1.5,
    `a fallback on a 2.4m deck (${a.parts[0].size[0]}) is no bigger than one on a 0.3m puck (${b.parts[0].size[0]})`);
  assert(a.parts.every(p => roleById('softgoods').materials.includes(p.material)), 'a fallback broke its own envelope');
  assert(a.parts[0].mount === 'deck_top', 'a fallback ignored its mount');
  assert(a.parts[1].attach.to === 0, 'a fallback did not build its own parts up off each other');
});

check('a plan that was not built by the crew still gets an owner on every step', () => {
  const plan = validatePlan(offlinePlan('a wooden stool', null), 'a wooden stool');
  for (const s of plan.steps) delete s.by;
  attributePlan(plan);
  for (const s of plan.steps) {
    assert(ROLE_IDS.includes(s.by), `step "${s.action}" is owned by "${s.by}"`);
    if (s.part) {
      const want = s.part.component ? 'electrical' : roleForMaterial(s.part.material);
      assert(s.by === want, `a ${s.part.material} part went to ${s.by} instead of ${want}`);
    }
  }
  const tally = crewTally(plan);
  assert(Object.values(tally).reduce((n, t) => n + t.steps, 0) === plan.steps.length, 'the tally lost steps');
});

/* ------------------------------------------------------------------ */
/* the floor, end to end                                               */
/* ------------------------------------------------------------------ */

/* A scripted model. `script` maps a role id to the JSON it will answer with;
   anything not in the script fails, which is how the degradation paths get
   exercised without any network. */
function fakeAsk(script) {
  const calls = [];
  return {
    calls,
    ask: async (messages, schema, who) => {
      calls.push({ who, system: messages[0].content, user: messages[1].content });
      const body = script[who];
      if (body == null) return { ok: false };
      if (body === 'throw') throw new Error('engine exploded');
      return { ok: true, text: typeof body === 'string' ? body : JSON.stringify(body), engine: 'test-engine' };
    }
  };
}

const LAMP_ORDER = {
  title: 'desk lamp', summary: 'a lamp that stands up',
  requirements: ['stands on its own'],
  frame: [
    { name: 'base', shape: 'cylinder', material: 'metal', size: [0.5, 0.12, 0.5] },
    { name: 'stem', shape: 'rod', material: 'metal', size: [0.14, 0.8, 0.14], attach: { to: 0, face: 'top' } }
  ],
  mounts: [{ id: 'stem_top', on: 1, face: 'top', note: 'shade' }, { id: 'base_top', on: 0, face: 'top' }],
  assignments: [
    { role: 'softgoods', mount: 'stem_top', parts: 2, brief: 'the shade and its collar', must: ['shade'] },
    { role: 'structures', mount: 'base_top', parts: 2, brief: 'the arm and its pivot', must: ['arm'] },
    { role: 'controls', parts: 0, brief: 'requirements' }
  ]
};

await acheck('a whole build runs through the floor and comes out solvable', async () => {
  const { ask, calls } = fakeAsk({
    foreman: LAMP_ORDER,
    softgoods: { notes: 'done', parts: [
      { name: 'shade', shape: 'cone', material: 'cardboard', size: [0.5, 0.32, 0.5], mount: 'stem_top', say: 'Rolling the cone.' },
      { name: 'collar', shape: 'cylinder', material: 'plastic', size: [0.16, 0.06, 0.16], attach: { to: 0, face: 'bottom' } }
    ] },
    structures: { notes: 'done', parts: [
      { name: 'arm', shape: 'rod', material: 'metal', size: [0.1, 0.5, 0.1], mount: 'base_top', say: 'Welding the arm.' },
      { name: 'pivot', shape: 'sphere', material: 'metal', size: [0.16, 0.16, 0.16], attach: { to: 0, face: 'top' } }
    ] },
    controls: { requirements: ['stands without falling over', 'the shade clears the stem'], checks: ['shade clears'] }
  });

  const floor = new ShopFloor({ ask });
  const { order, plan, ledger } = await floor.run('a desk lamp');

  assert(order.frame.length === 2, `the frame came back as ${order.frame.length} parts`);
  assert(calls.filter(c => c.who !== 'foreman').length === 3, `${calls.length - 1} specialists were asked, expected 3`);

  // every specialist was told about the frame and its mounts, and nobody was
  // told about anybody else's brief
  const soft = calls.find(c => c.who === 'softgoods');
  assert(/stem_top/.test(soft.system), 'the shade specialist was not told where the shade goes');
  assert(!/the arm and its pivot/.test(soft.system + soft.user), 'one specialist was shown another specialist’s brief');
  assert(/cardboard/.test(soft.system) && !/YOUR MATERIALS: metal/.test(soft.system), 'the brief did not state the trade’s materials');

  const parts = planParts(validatePlan(plan, 'desk lamp'));
  assert(parts.length === 6, `${parts.length} parts, expected 6`);
  parts.forEach((p, i) => assert(!p.attach || p.attach.to < i, `part ${i} attaches forward`));
  const report = inspectPlan(validatePlan(plan, 'desk lamp'));
  assert(report.solved.instances.length >= 6, 'the floor’s build does not solve');

  const s = ledger.summary;
  assert(s.delivered === 3 && s.failed === 0, `ledger says ${JSON.stringify(s)}`);
  assert(ledger.tasks.every(t => t.endedAt >= t.startedAt), 'a task ended before it started');
});

await acheck('the manager’s call failing does not stop the floor', async () => {
  const { ask } = fakeAsk({ softgoods: { parts: [{ name: 'panel', shape: 'panel', material: 'cardboard', size: [0.4, 0.05, 0.4], mount: 'base_top' }] } });
  const floor = new ShopFloor({ ask });
  const fallback = planParts(validatePlan(offlinePlan('a desk lamp', null), 'a desk lamp'));
  const { order, plan } = await floor.run('a desk lamp', { fallbackParts: fallback });
  assert(order.frame.length >= 1, 'no frame came out of the fallback split');
  assert(planParts(validatePlan(plan, 'x')).length >= 1, 'the floor produced nothing');
  assert(plan.steps.at(-1).action === 'present', 'the job never got handed over');
});

await acheck('one trade failing costs that trade’s parts and nothing else', async () => {
  const { ask } = fakeAsk({
    foreman: LAMP_ORDER,
    structures: { parts: [{ name: 'arm', shape: 'rod', material: 'metal', size: [0.1, 0.5, 0.1], mount: 'base_top' }] },
    softgoods: 'throw',
    controls: { requirements: ['stands up'] }
  });
  const floor = new ShopFloor({ ask });
  const { plan, ledger } = await floor.run('a desk lamp');
  const parts = planParts(validatePlan(plan, 'x'));
  assert(parts.some(p => p.name === 'arm'), 'the trade that worked lost its parts too');
  assert(parts.length > 3, `the failed trade left a hole: only ${parts.length} parts`);
  assert(ledger.tasks.find(t => t.role === 'softgoods').status === 'failed', 'the failure was not recorded');
  assert(ledger.tasks.find(t => t.role === 'structures').status === 'delivered', 'a working trade was marked failed');
  parts.forEach((p, i) => assert(!p.attach || p.attach.to < i, `part ${i} attaches forward after a fallback`));
});

await acheck('with nothing reachable at all the floor still builds', async () => {
  const floor = new ShopFloor({ ask: async () => ({ ok: false }) });
  const fallback = planParts(validatePlan(offlinePlan('a rover', null), 'a rover'));
  const { plan, ledger } = await floor.run('a rover', { offline: true, fallbackParts: fallback });
  const validated = validatePlan(plan, 'a rover');
  const parts = planParts(validated);
  assert(parts.length >= 3, `${parts.length} parts offline`);
  const solved = solveAssembly(parts);
  const lowest = Math.min(...solved.instances.map(i => i.pos[1] - i.half[1]));
  assert(Math.abs(lowest) < 0.05, `the offline build floats ${lowest.toFixed(3)}m`);
  assert(ledger.tasks.length >= 1, 'nothing was delegated');
  assert(ledger.tasks.every(t => t.status === 'delivered'), 'an offline task was not marked delivered');
});

await acheck('a circuit built by the electrical specialist still closes its loop', async () => {
  const order = validateOrder({
    title: 'a torch', summary: '', frame: [{ name: 'body', shape: 'box', material: 'metal', size: [0.6, 0.2, 0.4] }],
    mounts: [{ id: 'body_top', on: 0, face: 'top' }],
    assignments: [{ role: 'electrical', mount: 'body_top', parts: 4, brief: 'battery, switch, resistor, LED' }]
  }, 'a torch');

  const { ask } = fakeAsk({
    foreman: 'throw',
    electrical: {
      parts: [
        { name: 'battery', component: 'battery', shape: 'box', material: 'plastic', size: [0.3, 0.5, 0.2], mount: 'body_top' },
        { name: 'switch', component: 'switch', shape: 'box', material: 'plastic', size: [0.2, 0.2, 0.2], attach: { to: 0, face: 'right' } },
        { name: '220R', component: 'resistor', value: 220, shape: 'cylinder', material: 'plastic', size: [0.1, 0.3, 0.1], attach: { to: 0, face: 'front' } },
        { name: 'led', component: 'led', shape: 'cylinder', material: 'glass', size: [0.14, 0.2, 0.14], attach: { to: 0, face: 'back' } }
      ],
      wires: [
        { from: '0.+', to: '1.a' }, { from: '1.b', to: '2.a' },
        { from: '2.b', to: '3.+' }, { from: '3.-', to: '0.-' }
      ]
    }
  });
  const floor = new ShopFloor({ ask });
  const sub = await floor.runOne(floor.ledger.open('electrical', 'x', 4), order.assignments[0], order, { request: 'a torch' });
  const merged = validatePlan(mergeSubplans(order, [sub]), 'a torch');
  const parts = planParts(merged);

  assert(merged.wires?.length === 4, `${merged.wires?.length || 0} wires survived the merge and validation`);
  const findings = analyseCircuit(parts, merged.wires);
  const dead = findings.filter(f => /no supply|does not close|short|no way round/i.test(`${f.title || ''} ${f.what || ''}`));
  assert(!dead.length, `the merged circuit is broken: ${dead.map(f => f.title || f.what).join('; ')}`);
  const nets = netlist(parts, merged.wires);
  assert(nets.nets.length >= 4, `only ${nets.nets.length} nets — the pin shift lost connections`);
});

/* ------------------------------------------------------------------ */
/* the offline floor must not be worse than the old single robot        */
/* ------------------------------------------------------------------ */

/* This is the regression that would otherwise go unnoticed for weeks. With
   no engine reachable, the old shop built a keyword archetype — a lamp with
   a base, a stem and a cone shade, proportioned by hand. If splitting that
   across five robots loses a part, or hands a trade a generic barrel with
   the right name on it instead of the geometry the archetype specified, then
   the crew is a downgrade wearing an org chart, and it would still look
   busy and still produce something. So: every part in, every part out. */
await acheck('an offline build keeps every part the archetype had', async () => {
  const requests = ['a desk lamp', 'a wooden stool', 'a four wheeled rover',
    'a model rocket', 'a shelf bracket', 'a cardboard crate', 'a clock mechanism',
    'a robot', 'an LED torch circuit'];

  for (const req of requests) {
    const before = validatePlan(offlinePlan(req, null), req);
    const beforeParts = planParts(before);

    const floor = new ShopFloor({ ask: async () => ({ ok: false }) });
    const { plan, order } = await floor.run(req, { offline: true, fallbackParts: beforeParts });
    const after = validatePlan(plan, req);
    const afterParts = planParts(after);

    assert(afterParts.length === beforeParts.length,
      `"${req}": the archetype had ${beforeParts.length} parts, the floor produced ${afterParts.length}`);

    const nameOf = p => `${p.name}|${p.shape}`;
    const want = beforeParts.map(nameOf).sort();
    const got = afterParts.map(nameOf).sort();
    assert(want.join(' / ') === got.join(' / '),
      `"${req}": the parts changed.\n            was  ${want.join(', ')}\n            now  ${got.join(', ')}`);

    // every part still points backwards, and the thing still stands up
    afterParts.forEach((p, i) => assert(!p.attach || p.attach.to < i, `"${req}": part ${i} attaches forward`));
    const solved = solveAssembly(afterParts);
    const lowest = Math.min(...solved.instances.map(i => i.pos[1] - i.half[1]));
    assert(Math.abs(lowest) < 0.05, `"${req}": the offline build floats ${lowest.toFixed(3)}m off the pedestal`);

    // and it is genuinely split up, not one robot doing everything
    assert(order.frame.length >= 1, `"${req}": no frame`);
    const owners = new Set(after.steps.filter(st => st.part).map(st => st.by));
    assert(owners.size >= 1 && [...owners].every(o => ROLE_IDS.includes(o)),
      `"${req}": parts are owned by ${[...owners].join(', ')}`);
  }
});

/* A standoff is placement, not decoration. Onto a MOUNT the nudge used to
   be dropped on the way through the split — the sump went flat against the
   block, the engine stood on its crankshaft and toppled, and every part was
   still present and correct, which is exactly why the parity test above
   could not see it. So this one asks the other question: does the thing
   the floor hands back still stand up the way the archetype did? */
await acheck('the floor does not lose a standoff on the way through a mount', async () => {
  const requests = ['a 2JZ inline six', 'a v8 engine', 'a turbofan engine',
    'a brushless outrunner motor', 'a desk lamp'];

  for (const req of requests) {
    const before = validatePlan(offlinePlan(req, null), req);
    const beforeParts = planParts(before);
    const nudged = beforeParts.filter(p => p.attach && (p.attach.dx || p.attach.dy || p.attach.dz));

    const floor = new ShopFloor({ ask: async () => ({ ok: false }) });
    const { plan } = await floor.run(req, { offline: true, fallbackParts: beforeParts });
    const afterParts = planParts(attributePlan(validatePlan(plan, req)));

    for (const p of nudged) {
      const same = afterParts.find(q => q.name === p.name && q.shape === p.shape);
      assert(same, `"${req}": the ${p.name} did not survive the split`);
      for (const k of ['dx', 'dy', 'dz']) {
        if (!p.attach[k]) continue;
        assert(Math.abs((same.attach?.[k] || 0) - p.attach[k]) < 1e-6,
          `"${req}": the ${p.name} lost its ${k} (${p.attach[k]} → ${same.attach?.[k] ?? 'nothing'})`);
      }
    }

    /* and the check that would have caught it without knowing why */
    const stood = inspectPlan(before).solved.stable;
    const stands = inspectPlan(validatePlan(plan, req)).solved.stable;
    assert(!stood || stands, `"${req}": the archetype stood up and the floor's version falls over`);
  }
});

/* Third time this exact bug has been fixed, so it gets its own test. The
   merge rebuilds every part from the fields it knows about, so any tag it
   has not been taught about is dropped in silence: `engine_role` went that
   way once, the dx/dy/dz standoffs went that way once, and `moves` — the
   tag that says a wheel turns — went the same way. The object comes back
   complete and correct and simply does not work. */
await acheck('the floor does not drop the tags that make a part what it is', async () => {
  for (const req of ['a car with a v12 engine', 'a quadcopter drone', 'a bicycle']) {
    const before = validatePlan(offlinePlan(req, null), req);
    const beforeParts = planParts(before);
    const wantMoves = beforeParts.filter(p => p.moves).length;
    const wantEngine = beforeParts.filter(p => p.engine_role).length;

    const floor = new ShopFloor({ ask: async () => ({ ok: false }) });
    const { plan } = await floor.run(req, { offline: true, fallbackParts: beforeParts });
    const after = planParts(attributePlan(validatePlan(plan, req)));

    const gotMoves = after.filter(p => p.moves).length;
    const gotEngine = after.filter(p => p.engine_role).length;
    assert(gotMoves === wantMoves, `"${req}": ${wantMoves} moving parts went in, ${gotMoves} came out`);
    assert(gotEngine === wantEngine, `"${req}": ${wantEngine} engine parts went in, ${gotEngine} came out`);
    for (const p of after.filter(x => x.moves)) {
      assert(MOVERS.includes(p.moves), `"${req}": the ${p.name} moves as a "${p.moves}"`);
    }
  }
});

await acheck('an offline circuit still comes out wired, split across the floor', async () => {
  const req = 'an LED torch circuit';
  const before = validatePlan(offlinePlan(req, null), req);
  const floor = new ShopFloor({ ask: async () => ({ ok: false }) });
  const { plan } = await floor.run(req, { offline: true, fallbackParts: planParts(before) });
  const after = validatePlan(plan, req);
  const comps = planParts(after).filter(p => p.component);
  assert(comps.length >= 3, `only ${comps.length} components survived the split`);
  assert(after.steps.filter(st => st.part?.component).every(st => st.by === 'electrical'),
    'a component was made by somebody other than the electrical specialist');
});

check('Jarvis reports the floor rather than the object', () => {
  const l = new Ledger();
  l.deliver(l.start(l.open('structures', 'the frame', 2)), { parts: [1, 2], coerced: 0, dropped: 0, notes: '' });
  l.fail(l.start(l.open('softgoods', 'the skin', 2)), 'no engine answered');
  const text = jarvisReport({
    order: ORDER, ledger: l, issues: [],
    plan: { steps: [{ part: {}, by: 'structures' }, { part: {}, by: 'structures' }, { part: {}, by: 'foreman' }] }
  });
  assert(/Vulcan \(2\)/.test(text), `the report miscounts who made what: ${text}`);
  assert(/3 parts/.test(text), `the report miscounts the parts: ${text}`);
  assert(/failed/.test(text) && /Kraft/.test(text), 'the report hides a trade that failed');
  assert(text.length < 400, 'the report is not a report, it is a wall');
});

check('a lifecycle subscriber sees every task move', () => {
  const seen = [];
  const l = new Ledger(e => seen.push(`${e.kind}:${e.task.role}`));
  const t = l.open('structures', 'x', 2);
  l.start(t); l.deliver(t, { parts: [], coerced: 0, dropped: 0 });
  assert(seen.join(' ') === 'assign:structures working:structures delivered:structures', `saw ${seen.join(' ')}`);
  // and a subscriber that throws must not take the floor down with it
  const bad = new Ledger(() => { throw new Error('boom'); });
  bad.open('structures', 'x', 1);
});

check('the schemas describe what the validators actually accept', () => {
  assert(ORDER_SCHEMA.properties.assignments.items.properties.role.enum.join() === SPECIALIST_IDS.join(),
    'the manager’s schema and the roster disagree about who exists');
  assert(SUBPLAN_SCHEMA.properties.parts.items.properties.mount, 'a specialist has no way to name a mount');
  const msgs = buildSpecialistMessages('structures', ORDER, ORDER.assignments[0] || { role: 'structures', mount: 'mast_top', parts: 2, brief: 'x', must: [] });
  assert(msgs.length === 2 && msgs[0].role === 'system', 'the specialist prompt is malformed');
  assert(/mast_top/.test(msgs[0].content), 'the mounts do not reach the specialist');
  const om = buildOrderMessages('a lamp', [], [], null, null);
  assert(/WHO IS ON THE FLOOR/.test(om[0].content), 'the manager is not told who works here');
  const cm = buildControlsMessages(ORDER, { brief: 'x' }, 'a lamp');
  assert(/no parts/i.test(cm[0].content), 'controls is not told it makes no parts');
  assert(orderExpectations(ORDER, 'a desk lamp').length >= 1, 'the order expects nothing of the build');
  assert(parseJSON('```json\n{"a":1}\n```').a === 1, 'a fenced reply is not parsed');
});

console.log(out.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
