/* =====================================================================
   The parts catalogue, and putting one thing inside another.

   Two things are checked and they fail in completely different ways.

   THE ARCHETYPES are checked by BUILDING them. Every one of them is a
   hand-written attach tree, and the ways a hand-written attach tree goes
   wrong are all silent: a part hung off an arrayed parent that does not
   pair with it lands on instance one and the other three go without; a
   `row` array on a side face throws its offset away and four shelves come
   out in the same place; a part with nothing under it gets dropped by the
   solver and ends up somewhere nobody drew. So the gate is the solver's
   own report — nothing floats, nothing topples — run over the whole
   catalogue rather than over the two objects somebody remembered to check.

   THE COMPOSITION is checked on INDICES, like every other renumbering in
   this shop. "A car with a V12" is two objects merged, and the merge is
   the same arithmetic mergeSubplans does: get it wrong and half the engine
   silently reparents onto whatever the car happens to have at that index,
   solves fine, renders fine, and is quietly the wrong object.
   ===================================================================== */

import {
  ARCHETYPES, ARCHETYPE_IDS, MOVERS, matchArchetype, archetypeById, partsOf,
  compose, scaleParts, spanOf, fitFactor, catalogMotion, catalogBlock
} from '../renderer/catalog.js';
import { solveAssembly, SHAPES, MATERIALS, FACES, ARRAY_MODES } from '../renderer/assembly.js';
import { isShape } from '../renderer/shapelib.js';
import { assemblyMetrics } from '../renderer/metrics.js';
import { validatePlan, offlinePlan, planParts } from '../renderer/agent.js';
import { sizeEngine, engineParts, validateEngine } from '../renderer/engine.js';

let pass = 0, fail = 0;
const out = [];
const check = (name, fn) => {
  try { fn(); pass++; out.push(`  ok    ${name}`); }
  catch (e) { fail++; out.push(`  FAIL  ${name}\n          ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

/* An archetype is authored in degrees, as validatePlan expects. Solving one
   directly means converting first, exactly as validatePlan does. */
const buildOf = id => {
  const a = archetypeById(id);
  const parts = partsOf(a).map(p => ({ ...p, rot: p.rot ? p.rot.map(d => (d * Math.PI) / 180) : undefined }));
  return { archetype: a, parts, solved: solveAssembly(parts) };
};

/* ------------------------------------------------------------------ */
/* the catalogue itself                                                */
/* ------------------------------------------------------------------ */
check('every archetype is made of parts the shop can actually build', () => {
  assert(ARCHETYPES.length >= 25, `only ${ARCHETYPES.length} archetypes`);
  const seen = new Set();
  for (const a of ARCHETYPES) {
    assert(!seen.has(a.id), `two archetypes are called "${a.id}"`);
    seen.add(a.id);
    assert(a.words?.length >= 2, `${a.id} has nothing anybody would call it`);
    assert(a.note && a.note.length > 30, `${a.id} has no note saying how it goes together`);
    assert(a.parts.length >= 4, `${a.id} is only ${a.parts.length} parts — that is the old vocabulary`);
    assert(!a.parts[0].attach, `${a.id} part 0 is attached to something, so nothing stands on the pedestal`);

    a.parts.forEach((p, i) => {
      assert(isShape(p.shape), `${a.id} "${p.name}" is a "${p.shape}", which nothing can draw`);
      assert(MATERIALS.includes(p.material), `${a.id} "${p.name}" is made of "${p.material}"`);
      assert(p.size.length === 3 && p.size.every(v => v > 0 && v < 3), `${a.id} "${p.name}" is ${p.size}`);
      if (p.attach) {
        assert(p.attach.to < i, `${a.id} "${p.name}" attaches forward to ${p.attach.to}`);
        assert(FACES.includes(p.attach.face), `${a.id} "${p.name}" bolts to a "${p.attach.face}"`);
      }
      if (p.array) assert(ARRAY_MODES.includes(p.array.mode), `${a.id} "${p.name}" is arrayed "${p.array.mode}"`);
      if (p.moves) assert(MOVERS.includes(p.moves), `${a.id} "${p.name}" moves as a "${p.moves}"`);
    });

    for (const [name, m] of Object.entries(a.mounts || {})) {
      assert(m.to >= 0 && m.to < a.parts.length, `${a.id} mount "${name}" is on part ${m.to}, which does not exist`);
      assert(FACES.includes(m.face), `${a.id} mount "${name}" is on a "${m.face}"`);
      assert(m.span > 0.05 && m.span < 2, `${a.id} mount "${name}" has room for ${m.span}m`);
    }
  }
});

/* THE GATE. Not "does it look right" — that is what the renders are for —
   but "did the solver have to fix it". Every one of these was failing when
   the catalogue was first written, and every failure was invisible. */
check('every archetype stands up, with nothing floating and nothing dropped', () => {
  const bad = [];
  for (const id of ARCHETYPE_IDS) {
    const { solved } = buildOf(id);
    const m = assemblyMetrics(solved);
    const floated = (solved.notes || []).filter(n => /floating/.test(n));
    if (floated.length) bad.push(`${id}: ${floated[0]}`);
    if (!m.stable) bad.push(`${id}: it topples — the mass is ${Math.round((m.tipRatio - 1) * 100)}% outside the base`);
  }
  assert(!bad.length, bad.slice(0, 6).join('\n          '));
});

check('an arrayed part really is more than one part', () => {
  for (const id of ARCHETYPE_IDS) {
    const { archetype, solved } = buildOf(id);
    archetype.parts.forEach((p, i) => {
      if (!p.array || p.array.mode === 'none') return;
      const made = solved.instances.filter(x => x.src === i);
      const want = p.array.mode === 'quad' ? 4
        : p.array.mode.startsWith('mirror') ? 2
          : Math.max(2, p.array.count || 2);
      assert(made.length === want, `${id} "${p.name}": ${p.array.mode} made ${made.length}, not ${want}`);

      /* And they are in DIFFERENT places. A row array on a left or right
         face has its offset thrown away by the face placement, so four
         shelves come back stacked in exactly one spot — one board with
         three hidden inside it, and no error anywhere. */
      const spots = new Set(made.map(x => x.pos.map(v => v.toFixed(3)).join(',')));
      assert(spots.size === made.length,
        `${id} "${p.name}": ${made.length} of them, in ${spots.size} place(s)`);
    });
  }
});

/* ------------------------------------------------------------------ */
/* finding the right one                                               */
/* ------------------------------------------------------------------ */
check('a request finds the thing it is asking for', () => {
  const cases = [
    ['a car with a v12 engine', 'car'],
    ['a sports car', 'car'],
    ['a pickup truck', 'truck'],
    ['a quadcopter drone', 'drone'],
    ['a model aeroplane', 'airplane'],
    ['a helicopter', 'helicopter'],
    ['a bookshelf for records', 'shelf'],
    ['a dining table', 'table'],
    ['a desk lamp', 'lamp'],
    ['a robot arm with a gripper', 'robotarm'],
    ['a tower crane', 'crane'],
    ['a wind turbine', 'windmill'],
    ['a truss bridge', 'bridge'],
    ['a loudspeaker cabinet', 'speaker']
  ];
  for (const [ask, want] of cases) {
    const got = matchArchetype(ask);
    assert(got?.id === want, `"${ask}" found ${got ? got.id : 'nothing'}, wanted ${want}`);
  }
  assert(!matchArchetype(''), 'an empty request matched something');
  assert(!matchArchetype('a thingummy for the whatsit'), 'nonsense matched something');
});

check('a copy is a copy — building one does not edit the catalogue', () => {
  const a = archetypeById('car');
  const mine = partsOf(a);
  mine[0].size[0] = 99;
  mine[1].attach.face = 'top';
  assert(a.parts[0].size[0] !== 99, 'the catalogue entry was edited through a copy');
  assert(a.parts[1].attach.face !== 'top', 'the attachment was edited through a copy');
});

/* ------------------------------------------------------------------ */
/* putting one thing inside another                                    */
/* ------------------------------------------------------------------ */
/* The arithmetic, on indices. This is the one that reparents half an
   engine onto a wheel and never says a word about it. */
check('composing renumbers every attachment onto the end of the host', () => {
  const host = [
    { name: 'a', shape: 'box', material: 'metal', size: [1, 1, 1] },
    { name: 'b', shape: 'box', material: 'metal', size: [1, 1, 1], attach: { to: 0, face: 'top' } },
    { name: 'c', shape: 'box', material: 'metal', size: [1, 1, 1], attach: { to: 1, face: 'top' } }
  ];
  const add = [
    { name: 'x', shape: 'box', material: 'alloy', size: [1, 1, 1] },
    { name: 'y', shape: 'box', material: 'alloy', size: [1, 1, 1], attach: { to: 0, face: 'top' } },
    { name: 'z', shape: 'box', material: 'alloy', size: [1, 1, 1], attach: { to: 1, face: 'left' } }
  ];
  const { parts, offset } = compose(host, add, { to: 1, face: 'top', dx: 0.2 });

  assert(offset === 3, `the block landed at ${offset}`);
  assert(parts.length === 6, `${parts.length} parts after composing 3 and 3`);
  assert(parts.slice(0, 3).every((p, i) => p.name === host[i].name), 'the host was disturbed');

  // the subsystem's root took the mount
  assert(parts[3].attach.to === 1 && parts[3].attach.face === 'top' && parts[3].attach.dx === 0.2,
    `the root bolted to ${JSON.stringify(parts[3].attach)}`);
  // and everything else kept ITS OWN parent, shifted
  assert(parts[4].attach.to === 3, `"y" reparented to ${parts[4].attach.to} instead of 3`);
  assert(parts[5].attach.to === 4, `"z" reparented to ${parts[5].attach.to} instead of 4`);
  assert(parts[5].attach.face === 'left', 'the face was lost in the renumbering');

  // and every attachment still points backwards, which is what validatePlan requires
  parts.forEach((p, i) => assert(!p.attach || p.attach.to < i, `part ${i} attaches forward`));
});

check('a mount with no room for it shrinks what goes in', () => {
  const host = [{ name: 'a', shape: 'box', material: 'metal', size: [1, 1, 1] }];
  const add = [
    { name: 'big', shape: 'box', material: 'alloy', size: [2, 1, 1], attach: null },
    { name: 'small', shape: 'box', material: 'alloy', size: [0.4, 0.4, 0.4], attach: { to: 0, face: 'top', dy: 0.5 }, array: { mode: 'row', count: 3, spacing: 0.3 } }
  ];
  const { parts, scale } = compose(host, add, { to: 0, face: 'top', span: 0.5 });
  assert(Math.abs(scale - 0.25) < 1e-9, `scaled by ${scale}, wanted 0.25`);
  assert(Math.abs(parts[1].size[0] - 0.5) < 1e-9, `the big part came out ${parts[1].size[0]}`);

  /* the offsets and the array pitch scale WITH the parts, or a shrunken
     block comes out as a scattering of small parts at full spacing */
  assert(Math.abs(parts[2].attach.dy - 0.125) < 1e-9, `the standoff is ${parts[2].attach.dy}`);
  assert(Math.abs(parts[2].array.spacing - 0.075) < 1e-9, `the pitch is ${parts[2].array.spacing}`);

  assert(fitFactor(add, 4) === 1, 'something that already fits was scaled up');
  assert(spanOf(add) === 2, `the block measures ${spanOf(add)}`);
});

check('composing nothing leaves the host exactly as it was', () => {
  const host = partsOf(archetypeById('car'));
  const same = compose(host, [], { to: 0, face: 'top' });
  assert(same.parts.length === host.length, 'the host changed size');
  assert(same.parts[0] === host[0], 'the host was rebuilt for no reason');
});

/* ------------------------------------------------------------------ */
/* the whole point                                                     */
/* ------------------------------------------------------------------ */
/* The bug as it was reported: a car with a V12 came back as neither. */
check('a car with a V12 is a car AND a V12', () => {
  const ask = 'a car with a v12 engine';
  const plan = validatePlan(offlinePlan(ask, null), ask);
  const parts = planParts(plan);

  const named = parts.map(p => p.name.toLowerCase()).join(' ');
  for (const want of ['chassis', 'wheel', 'body', 'cabin']) {
    assert(named.includes(want), `no ${want} — that is not a car: ${named}`);
  }
  const engineParts_ = parts.filter(p => p.engine_role);
  assert(engineParts_.length >= 10, `only ${engineParts_.length} engine parts — that is not a V12`);
  assert(plan.engine?.kind === 'ice' && plan.engine.cylinders === 12,
    `the engine on the plan is ${plan.engine?.cylinders} cylinders`);

  /* the engine is IN the car, not standing beside it: its root hangs off a
     part of the car, and every other engine part hangs off the engine */
  const firstEngine = parts.findIndex(p => p.engine_role);
  const root = parts[firstEngine];
  assert(root.attach && root.attach.to < firstEngine, 'the engine is not bolted to the car at all');
  assert(!parts[root.attach.to].engine_role, 'the engine is bolted to itself');

  /* and it was made SMALLER to fit, without the arithmetic changing: the
     bench still reports a real 12-cylinder engine */
  assert(plan.engine.fit < 1, `the engine was dropped in at ${plan.engine.fit} of full size`);
  const whole = engineParts(sizeEngine(validateEngine({ ...plan.engine, fit: 1 })));
  assert(spanOf(whole) > spanOf(engineParts(sizeEngine(plan.engine), { fit: plan.engine.fit })),
    'the engine in the car is the same size as one on its own');

  const solved = solveAssembly(parts);
  const m = assemblyMetrics(solved);
  assert(m.stable, 'the car falls over with its engine in');
  assert(!(solved.notes || []).some(n => /floating/.test(n)), 'something floats');
});

/* A host with nowhere to put an engine gets the engine as the object, not
   an engine hidden inside a bookshelf. */
check('a host with no engine bay does not get one wedged into it', () => {
  const ask = 'a bookshelf with a v8 engine';
  const plan = validatePlan(offlinePlan(ask, null), ask);
  const parts = planParts(plan);
  assert(parts.some(p => p.engine_role), 'the engine went missing entirely');
  assert(plan.engine?.fit === 1 || plan.engine?.fit === undefined,
    'an engine that is the whole object was shrunk anyway');
});

check('an object that is only itself is not given an engine it never asked for', () => {
  const plan = validatePlan(offlinePlan('a dining table', null), 'a dining table');
  assert(!plan.engine, 'a table came with an engine');
  assert(!planParts(plan).some(p => p.engine_role), 'a table has engine parts in it');
});

/* ------------------------------------------------------------------ */
/* what moves                                                          */
/* ------------------------------------------------------------------ */
check('a wheel turns about the axle it was stood up onto', () => {
  const ask = 'a car with a v12 engine';
  const plan = validatePlan(offlinePlan(ask, null), ask);
  const parts = planParts(plan);
  const motion = catalogMotion(parts);
  assert(motion.length >= 2, `${motion.length} things turn on a car`);
  for (const m of motion) {
    assert(parts[m.part], `motion points at part ${m.part}, which does not exist`);
    assert(m.rpm > 0 && m.kind === 'spin', `a ${parts[m.part].name} turns at ${m.rpm}`);
    /* A wheel is a flat ring rolled 90° about Z, which lays its axle along
       X. Comparing that rotation against 45 while it is in RADIANS is
       always false, and every wheel then span about the wrong axis — which
       looks like a wheel skidding sideways down the shop. */
    if (parts[m.part].moves === 'wheel') assert(m.axis === 'x', `a wheel turns about ${m.axis}`);
  }
});

check('a part with no tag does not move, and the tag survives the validator', () => {
  const plan = validatePlan(offlinePlan('a dining table', null), 'a dining table');
  assert(catalogMotion(planParts(plan)).length === 0, 'a table has moving parts');

  const drone = validatePlan(offlinePlan('a quadcopter drone', null), 'a quadcopter drone');
  const tagged = planParts(drone).filter(p => p.moves);
  assert(tagged.length, 'the moving parts lost their tag on the way through validatePlan');
  assert(tagged.every(p => MOVERS.includes(p.moves)), 'a tag survived that is not a way of moving');
});

/* ------------------------------------------------------------------ */
/* what the planner is told                                            */
/* ------------------------------------------------------------------ */
check('the planner is told how the thing it was asked for goes together', () => {
  const block = catalogBlock('a car with a v12 engine');
  assert(/HOW A CAR GOES TOGETHER/.test(block), 'the prompt does not say what a car is');
  assert(/chassis/.test(block) && /wheel/.test(block), 'the prompt lists no parts');
  assert(/engine/.test(block), 'the prompt never mentions that the engine is a separate set of parts');
  assert(catalogBlock('a thingummy') === '', 'something unknown still got a lecture');
});

console.log(out.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
