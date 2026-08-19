/* Headless checks on the two pure modules — the assembly solver and the
   skill library. Neither imports three.js or touches the DOM, which is the
   whole reason they are separate files.

     npm test
*/
import { solveAssembly, auditSolved, halfExtents, effectiveSize } from '../renderer/assembly.js';
import { recall, learn, recipeFrom, tokenize, sanitize, deterministicReflection } from '../renderer/skills.js';

let pass = 0, fail = 0;
const results = [];

function check(name, fn) {
  try {
    fn();
    pass++; results.push(`  ok    ${name}`);
  } catch (e) {
    fail++; results.push(`  FAIL  ${name}\n          ${e.message}`);
  }
}
const assert = (c, m) => { if (!c) throw new Error(m); };

/* ------------------------------------------------------------------ */
/* fixtures — the shapes people actually ask for                       */
/* ------------------------------------------------------------------ */
const LAMP = [
  { name: 'base', shape: 'cylinder', material: 'metal', size: [0.5, 0.12, 0.5] },
  { name: 'stem', shape: 'rod', material: 'metal', size: [0.14, 0.8, 0.14], attach: { to: 0, face: 'top' } },
  { name: 'shade', shape: 'cone', material: 'painted', size: [0.44, 0.32, 0.44], attach: { to: 1, face: 'top' } }
];

const TABLE = [
  { name: 'top', shape: 'panel', material: 'wood', size: [1.2, 0.08, 0.9] },
  { name: 'leg', shape: 'rod', material: 'metal', size: [0.12, 0.68, 0.12], attach: { to: 0, face: 'bottom' }, array: { mode: 'quad', radius: 0.44, count: 4 } }
];

const ROCKET = [
  { name: 'body', shape: 'cylinder', material: 'metal', size: [0.44, 1.5, 0.44] },
  { name: 'nose', shape: 'cone', material: 'painted', size: [0.44, 0.5, 0.44], attach: { to: 0, face: 'top' } },
  { name: 'fin', shape: 'panel', material: 'metal', size: [0.34, 0.42, 0.5], attach: { to: 0, face: 'right', dy: -0.5 }, array: { mode: 'ring', count: 3, radius: 0.26 } }
];

const ROVER = [
  { name: 'chassis', shape: 'box', material: 'metal', size: [1.3, 0.24, 0.72] },
  { name: 'wheel', shape: 'torus', material: 'plastic', size: [0.38, 0.13, 0.38], attach: { to: 0, face: 'left' }, array: { mode: 'mirror_z', radius: 0.36, count: 2 } },
  { name: 'wheel', shape: 'torus', material: 'plastic', size: [0.38, 0.13, 0.38], attach: { to: 0, face: 'right' }, array: { mode: 'mirror_z', radius: 0.36, count: 2 } }
];

/* what a bad model actually emits: everything floating, everything a box */
const GARBAGE = [
  { name: 'slab', shape: 'box', material: 'metal', size: [0.8, 0.2, 0.6], at: [0, 2.4, 0] },
  { name: 'slab', shape: 'box', material: 'metal', size: [0.8, 0.2, 0.6], at: [0.1, 1.9, 0.05] },
  { name: 'slab', shape: 'box', material: 'metal', size: [0.8, 0.2, 0.6], at: [0, 3.1, 0] }
];

/* a model that drove two parts straight through each other */
const BURIED = [
  { name: 'block', shape: 'box', material: 'metal', size: [0.8, 0.8, 0.8], at: [0, 0.4, 0] },
  { name: 'other', shape: 'box', material: 'metal', size: [0.6, 0.6, 0.6], at: [0.05, 0.45, 0.05] }
];

const bottom = i => i.pos[1] - i.half[1];
const top = i => i.pos[1] + i.half[1];
const ov = (a, b, ax) => Math.max(0, Math.min(a.pos[ax] + a.half[ax], b.pos[ax] + b.half[ax]) - Math.max(a.pos[ax] - a.half[ax], b.pos[ax] - b.half[ax]));

function nothingFloats(solved, label) {
  for (const inst of solved.instances) {
    if (inst.fixed) continue;                 // held by its parent's side face
    const b = bottom(inst);
    if (b <= 0.09) continue;                  // on the pedestal
    /* Something under it, top to bottom — a leg, a plinth, the part below
       it in a stack. */
    const stacked = solved.instances.some(o => o !== inst && Math.abs(top(o) - b) < 0.12 &&
      ov(inst, o, 0) > 0.001 && ov(inst, o, 2) > 0.001);
    /* Or something OF ITS OWN that straddles it and reaches the ground: a
       crate's floor is held by walls that pass it on both sides, a car's
       chassis by wheels hung off its ends. Those are not floating parts,
       they are parts that are carried — and demanding a top-to-bottom
       contact under them would mean a crate has to sit on its own floor.

       No overlap test on this one: a face places a child ALONGSIDE its
       parent rather than through it, so a wheel on the end of a chassis
       overlaps it in exactly nothing. Being its part and reaching past its
       bottom is the whole claim. */
    const straddled = solved.instances.some(o => o !== inst && o.parent === inst.i && bottom(o) < b - 0.01);
    const held = stacked || straddled;
    assert(held, `${label}: "${inst.name}" floats at y=${b.toFixed(2)} with nothing under it`);
  }
}

function nothingBuried(solved, label) {
  const list = solved.instances;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (a.parent === b.i || b.parent === a.i) continue;
      if (a.group === b.group && a.ofGroup > 1) continue;
      const v = ov(a, b, 0) * ov(a, b, 1) * ov(a, b, 2);
      const vol = Math.min(8 * a.half[0] * a.half[1] * a.half[2], 8 * b.half[0] * b.half[1] * b.half[2]);
      const frac = v / vol;
      assert(frac < 0.4, `${label}: "${a.name}" and "${b.name}" are ${Math.round(frac * 100)}% inside each other`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* the solver                                                          */
/* ------------------------------------------------------------------ */
check('lamp: three parts stack base → stem → shade', () => {
  const s = solveAssembly(LAMP);
  assert(s.instances.length === 3, `expected 3 parts, got ${s.instances.length}`);
  const [base, stem, shade] = s.instances;
  assert(Math.abs(bottom(base)) < 0.02, 'the base is not sitting on the pedestal');
  assert(Math.abs(bottom(stem) - top(base)) < 0.02, 'the stem is not standing on the base');
  assert(Math.abs(bottom(shade) - top(stem)) < 0.02, 'the shade is not sitting on the stem');
  nothingFloats(s, 'lamp');
  nothingBuried(s, 'lamp');
  assert(auditSolved(s).length === 0, 'audit complained: ' + auditSolved(s).join('; '));
});

check('table: one leg part becomes four legs holding the top up', () => {
  const s = solveAssembly(TABLE);
  assert(s.instances.length === 5, `expected 1 top + 4 legs, got ${s.instances.length}`);
  const legs = s.instances.filter(i => i.name === 'leg');
  assert(legs.length === 4, 'quad array did not produce four legs');
  const xs = new Set(legs.map(l => l.pos[0].toFixed(2)));
  const zs = new Set(legs.map(l => l.pos[2].toFixed(2)));
  assert(xs.size === 2 && zs.size === 2, 'the legs are not at four distinct corners');
  const topPart = s.instances[0];
  assert(bottom(topPart) > 0.5, `the top collapsed onto the pedestal (bottom at ${bottom(topPart).toFixed(2)})`);
  legs.forEach(l => assert(Math.abs(bottom(l)) < 0.02, 'a leg is not reaching the pedestal'));
  nothingBuried(s, 'table');
});

check('rocket: three fins ring the body and do not fall off', () => {
  const s = solveAssembly(ROCKET);
  const fins = s.instances.filter(i => i.name === 'fin');
  assert(fins.length === 3, `expected 3 fins, got ${fins.length}`);
  fins.forEach(f => assert(f.fixed, 'a side-attached fin was treated as loose and dropped'));
  const angles = new Set(fins.map(f => f.rot[1].toFixed(3)));
  assert(angles.size === 3, 'the fins were not turned to face outward');
  const spots = new Set(fins.map(f => `${f.pos[0].toFixed(2)},${f.pos[2].toFixed(2)}`));
  assert(spots.size === 3, 'the fins are all stacked in one place instead of ringing the body');
  const body0 = s.instances.find(i => i.name === 'body');
  fins.forEach(f => assert(Math.hypot(f.pos[0] - body0.pos[0], f.pos[2] - body0.pos[2]) > body0.half[0] * 0.8,
    'a fin is inside the body rather than standing off it'));
  const nose = s.instances.find(i => i.name === 'nose');
  const body = s.instances.find(i => i.name === 'body');
  assert(nose.pos[1] > body.pos[1], 'the nose cone is not above the body');
  nothingFloats(s, 'rocket');
});

check('rover: four wheels, two a side, none inside the chassis', () => {
  const s = solveAssembly(ROVER);
  const wheels = s.instances.filter(i => i.name === 'wheel');
  assert(wheels.length === 4, `expected 4 wheels, got ${wheels.length}`);
  const left = wheels.filter(w => w.pos[0] < 0), right = wheels.filter(w => w.pos[0] > 0);
  assert(left.length === 2 && right.length === 2, 'the wheels are not two a side');
  assert(new Set(wheels.map(w => w.pos[2].toFixed(2))).size === 2, 'the wheels are not front and back');
  nothingBuried(s, 'rover');
});

check('garbage in: three floating slabs all get dropped', () => {
  const s = solveAssembly(GARBAGE);
  nothingFloats(s, 'garbage');
  assert(s.notes.some(n => /float/i.test(n)), 'the solver did not report catching the floaters');
  const issues = auditSolved(s);
  assert(issues.some(i => /every part is a/i.test(i)), 'the audit did not object to three identical slabs');
});

check('interpenetration gets pushed apart', () => {
  const s = solveAssembly(BURIED);
  nothingBuried(s, 'buried');
});

check('an oversized build is scaled to fit the pedestal', () => {
  const big = [
    { name: 'slab', shape: 'box', material: 'metal', size: [2.5, 0.3, 2.5] },
    { name: 'mast', shape: 'rod', material: 'metal', size: [0.3, 2.5, 0.3], attach: { to: 0, face: 'top' } },
    { name: 'cap', shape: 'box', material: 'metal', size: [1.5, 1.2, 1.5], attach: { to: 1, face: 'top' } }
  ];
  const s = solveAssembly(big);
  assert(s.fit < 1, 'nothing was scaled');
  const w = s.bounds.max[0] - s.bounds.min[0];
  assert(w <= 2.45, `still ${w.toFixed(2)}m wide after fitting`);
  assert(s.bounds.max[1] <= 3.05, `still ${s.bounds.max[1].toFixed(2)}m tall after fitting`);
});

check('an attachment cycle cannot hang the solver', () => {
  // validatePlan forbids these, but the solver is the last line of defence
  const s = solveAssembly([
    { name: 'a', shape: 'box', material: 'metal', size: [0.4, 0.4, 0.4], attach: { to: 1, face: 'top' } },
    { name: 'b', shape: 'box', material: 'metal', size: [0.4, 0.4, 0.4], attach: { to: 0, face: 'top' } }
  ]);
  assert(s.instances.length === 2, 'the cycle lost a part');
  s.instances.forEach(i => assert(Number.isFinite(i.pos[1]), 'a position came out NaN'));
});

check('joints are found where parts actually touch', () => {
  const s = solveAssembly(LAMP);
  assert(s.joints.length >= 2, `expected at least 2 joints, got ${s.joints.length}`);
  assert(s.joints.every(j => j.kind === 'weld' || j.kind === 'bolt' || j.kind === 'glue'), 'a joint has no kind');
  const metal = solveAssembly([
    { name: 'a', shape: 'box', material: 'metal', size: [0.5, 0.3, 0.5] },
    { name: 'b', shape: 'box', material: 'metal', size: [0.5, 0.3, 0.5], attach: { to: 0, face: 'top' } }
  ]);
  assert(metal.joints[0].kind === 'weld', 'steel on steel should be welded, got ' + metal.joints[0].kind);
});

check('effective size matches what actually gets drawn', () => {
  assert(effectiveSize('rod', [0.6, 1, 0.6])[0] < 0.25, 'a rod is drawn far thinner than its stated width');
  assert(effectiveSize('panel', [1, 0.5, 0.8])[1] < 0.12, 'a slab-shaped panel was not flattened');
  const sheet = effectiveSize('panel', [1.2, 0.08, 0.9]);
  assert(sheet[0] === 1.2 && sheet[2] === 0.9, 'a tabletop that was already a sheet got mangled');
  const h = halfExtents('box', [1, 0.2, 0.2], [0, 0, Math.PI / 2]);
  assert(Math.abs(h[1] - 0.5) < 0.01, 'a box laid on its side did not change its bounds');
});

/* ------------------------------------------------------------------ */
/* the skill library                                                   */
/* ------------------------------------------------------------------ */
const fakePlan = {
  title: 'desk lamp', summary: 'a lamp',
  steps: [
    { room: 'software', action: 'type', say: 'drafting', seconds: 3 },
    { room: 'metal', action: 'saw_metal', say: 'cutting', seconds: 4, part: LAMP[0] },
    { room: 'metal', action: 'weld', say: 'welding', seconds: 4, part: LAMP[1] },
    { room: 'finished', action: 'paint', say: 'painting', seconds: 4, part: LAMP[2] },
    { room: 'finished', action: 'present', say: 'done', seconds: 3 }
  ]
};
const fakeReflection = {
  name: 'desk lamp', object_class: 'lamp',
  keywords: ['lamp', 'light', 'shade', 'desk', 'stem'],
  summary: 'a lamp', reuse_when: 'another lamp',
  roles: [{ i: 0, role: 'base' }, { i: 1, role: 'stem' }, { i: 2, role: 'shade' }],
  lessons: ['The shade must be a cone on top of the stem, not a box.']
};

check('a recipe replays the attach graph, not prose', () => {
  const r = recipeFrom(fakePlan, fakeReflection.roles);
  assert(r.parts.length === 3, 'wrong part count');
  assert(r.parts[0].role === 'base' && r.parts[2].role === 'shade', 'roles were not applied');
  assert(r.parts[1].attach.to === 0, 'the attachment was lost');
  assert(r.process.length === 5, 'the order of operations was lost');
  assert(r.process[1].part === 0 && r.process[4].part === null, 'process steps do not point at their parts');
  const again = solveAssembly(r.parts);
  assert(again.instances.length === 3, 'the stored recipe no longer solves');
});

check('learning a class once, then recalling it', () => {
  const solved = solveAssembly(LAMP);
  let lib = [];
  ({ skills: lib } = learn(lib, { request: 'a desk lamp with a folding arm', plan: fakePlan, solved, reflection: fakeReflection, corrections: [], clean: true }));
  assert(lib.length === 1, 'nothing was learned');
  assert(lib[0].class === 'lamp', 'wrong class');
  assert(lib[0].confidence > 0.5, 'a clean build should raise confidence');

  const hit = recall(lib, 'a bedside reading lamp');
  assert(hit, 'a lamp request did not recall the lamp skill');
  assert(hit.skill.class === 'lamp', 'recalled the wrong skill');

  assert(!recall(lib, 'a welded steel gate for the yard'), 'recalled a lamp for a gate');
});

check('rebuilding a class updates it rather than duplicating it', () => {
  const solved = solveAssembly(LAMP);
  let lib = [];
  ({ skills: lib } = learn(lib, { request: 'a desk lamp', plan: fakePlan, solved, reflection: fakeReflection, corrections: [], clean: true }));
  const c1 = lib[0].confidence;
  ({ skills: lib } = learn(lib, { request: 'a floor lamp', plan: fakePlan, solved, reflection: fakeReflection, corrections: [], clean: true }));
  assert(lib.length === 1, `a second lamp made a second skill (${lib.length})`);
  assert(lib[0].stats.uses === 2, 'the build count did not go up');
  assert(lib[0].confidence > c1, 'a second clean build did not raise confidence');
});

check('a corrected build learns the correction, not the mistake', () => {
  const solved = solveAssembly(LAMP);
  let lib = [];
  ({ skills: lib } = learn(lib, {
    request: 'a desk lamp', plan: fakePlan, solved, reflection: fakeReflection,
    corrections: ['the shade was a box'], clean: false
  }));
  assert(lib[0].stats.corrections === 1, 'the correction was not counted');
  assert(lib[0].confidence < 0.55, 'a corrected build should not be as trusted as a clean one');
  // the recipe on file is the fixed geometry, so the next build starts from the cone
  assert(lib[0].recipe.parts[2].shape === 'cone', 'the stored recipe kept the broken part');
});

check('offline builds learn too', () => {
  const solved = solveAssembly(ROCKET);
  const r = deterministicReflection('a model rocket with fins', { title: 'model rocket', summary: '', steps: fakePlan.steps }, solved, []);
  assert(r.object_class === 'rocket', `classified as ${r.object_class}`);
  assert(r.keywords.includes('rocket'), 'the class is not among the keywords');
  assert(r.lessons.length > 0, 'no lesson was recorded');
});

check('a skill file off disk is not trusted blindly', () => {
  const out = sanitize([
    { class: 'lamp', recipe: { parts: [], process: [] }, confidence: 47, name: 'x'.repeat(200) },
    { nonsense: true },
    null
  ]);
  assert(out.length === 1, 'garbage entries got through');
  assert(out[0].confidence <= 1, 'confidence was not clamped');
  assert(out[0].name.length <= 48, 'the name was not truncated');
});

check('tokenizer drops filler and folds plurals', () => {
  const t = tokenize('Build me a shelf that holds twelve records');
  assert(!t.includes('build') && !t.includes('me') && !t.includes('a'), 'filler survived: ' + t.join(','));
  assert(t.includes('record'), 'plural was not folded: ' + t.join(','));
});

/* ------------------------------------------------------------------ */
/* end to end, no renderer: request → plan → validate → solve          */
/* ------------------------------------------------------------------ */
const { offlinePlan, validatePlan, planParts } = await import('../renderer/agent.js');

const REQUESTS = [
  'a desk lamp with a folding arm',
  'a cardboard robot with working elbows',
  'a wall shelf that holds twelve records',
  'a rover chassis with four wheels',
  'a coffee grinder stand',
  'a rocket model with fins',
  'something to keep the door open',
  'a crate for tools'
];

for (const req of REQUESTS) {
  check(`offline pipeline: "${req}"`, () => {
    const plan = validatePlan(offlinePlan(req), req);
    assert(plan.steps.length >= 8, `only ${plan.steps.length} steps`);
    assert(plan.steps[plan.steps.length - 1].room === 'finished', 'the job does not end in the gallery');
    const parts = planParts(plan);
    assert(parts.length >= 3, `only ${parts.length} parts`);
    parts.forEach((p, i) => {
      assert(!p.attach || p.attach.to < i, `part ${i} attaches to a part that does not exist yet`);
    });
    const solved = solveAssembly(parts);
    assert(solved.instances.length >= parts.length, 'the solver lost parts');
    nothingFloats(solved, req);
    nothingBuried(solved, req);
    assert(solved.bounds.max[1] > 0.2, 'the build is flat');
    solved.instances.forEach(i => i.pos.forEach(v => assert(Number.isFinite(v), 'a NaN position')));
  });
}

check('a recalled skill drives the offline planner', () => {
  const solved = solveAssembly(LAMP);
  let lib = [];
  ({ skills: lib } = learn(lib, { request: 'a desk lamp', plan: fakePlan, solved, reflection: fakeReflection, corrections: [], clean: true }));
  const hit = recall(lib, 'a small reading lamp for the bedside');
  assert(hit, 'the lamp skill was not recalled');
  const plan = validatePlan(offlinePlan('a small reading lamp for the bedside', hit), 'lamp');
  const parts = planParts(plan);
  assert(parts.length === 3, `the learned recipe was not used (${parts.length} parts)`);
  assert(parts[2].shape === 'cone', 'the shade came back as something other than a cone');
  const s2 = solveAssembly(parts);
  nothingFloats(s2, 'recalled lamp');
  assert(/learned/i.test(plan.summary), 'the plan does not say it came from memory');
});

/* ------------------------------------------------------------------ */
/* editing a plan by hand from the CAD bench                           */
/* ------------------------------------------------------------------ */
const agent = await import('../renderer/agent.js');
const { editPart, addPart, removePart } = agent;
const { describeEdits } = await import('../renderer/skills.js');

const benchPlan = () => validatePlan({
  title: 'rover', summary: '', steps: [
    { room: 'software', action: 'type', say: 'drafting', seconds: 3 },
    { room: 'metal', action: 'saw_metal', say: 'chassis', seconds: 4, part: { name: 'chassis', shape: 'box', material: 'metal', size: [1.3, 0.24, 0.72] } },
    { room: 'metal', action: 'weld', say: 'wheels', seconds: 4, part: { name: 'wheel', shape: 'torus', material: 'plastic', size: [0.38, 0.13, 0.38], attach: { to: 0, face: 'left' }, array: { mode: 'mirror_z', count: 2, radius: 0.36 } } },
    { room: 'metal', action: 'drill', say: 'mast', seconds: 3, part: { name: 'mast', shape: 'rod', material: 'metal', size: [0.1, 0.5, 0.1], attach: { to: 0, face: 'top' } } },
    { room: 'finished', action: 'present', say: 'done', seconds: 3 }
  ]
}, 'rover');

check('bench edit: changing a shape and size re-solves', () => {
  const plan = benchPlan();
  editPart(plan, 2, { shape: 'cone', sy: 0.9 });
  const parts = planParts(plan);
  assert(parts[2].shape === 'cone', 'the shape did not change');
  assert(Math.abs(parts[2].size[1] - 0.9) < 1e-6, 'the size did not change');
  const s = solveAssembly(parts);
  nothingFloats(s, 'edited rover');
});

check('bench edit: rubbish from the DOM is clamped, not trusted', () => {
  const plan = benchPlan();
  editPart(plan, 1, { shape: 'banana', material: 'unobtainium', sx: '99', sy: '-4', count: '900', mode: 'ring' });
  const p = planParts(plan)[1];
  assert(p.shape === 'torus', 'an unknown shape got through');
  assert(p.material === 'plastic', 'an unknown material got through');
  assert(p.size[0] <= 2.5 && p.size[1] >= 0.15, `sizes not clamped: ${p.size}`);
  assert(p.array.count <= 8, `count not clamped: ${p.array.count}`);
});

check('bench edit: detaching a part puts it on the pedestal', () => {
  const plan = benchPlan();
  editPart(plan, 2, { to: '' });
  assert(!planParts(plan)[2].attach, 'the attachment survived');
  const s = solveAssembly(planParts(plan));
  nothingFloats(s, 'detached');
});

check('bench edit: a part cannot be bolted to itself or to a later part', () => {
  const plan = benchPlan();
  editPart(plan, 1, { to: '1' });
  assert(!planParts(plan)[1].attach, 'a part was allowed to attach to itself');
  editPart(plan, 1, { to: '2' });
  assert(!planParts(plan)[1].attach, 'a part was allowed to attach to a later part');
});

check('adding a part lands at the end and still ends in the gallery', () => {
  const plan = benchPlan();
  const before = planParts(plan).length;
  const { index } = addPart(plan, { name: 'aerial', shape: 'rod', material: 'metal' });
  const parts = planParts(plan);
  assert(parts.length === before + 1, 'no part was added');
  assert(index === before, `wrong index ${index}`);
  assert(parts[index].attach.to === before - 1, 'the new part is not bolted to anything');
  assert(plan.steps[plan.steps.length - 1].room === 'finished', 'the job no longer ends in the gallery');
  nothingFloats(solveAssembly(parts), 'after add');
});

check('removing a part renumbers every attachment that pointed past it', () => {
  const plan = benchPlan();
  removePart(plan, 0);                       // the chassis, which parts 1 and 2 hang off
  const parts = planParts(plan);
  assert(parts.length === 2, `expected 2 parts, got ${parts.length}`);
  parts.forEach((p, i) => {
    assert(!p.attach || p.attach.to < i, `part ${i} still points at ${p.attach?.to}`);
  });
  assert(!parts[0].attach, 'the orphan was not put back on the pedestal');
  const s = solveAssembly(parts);
  nothingFloats(s, 'after remove');
  s.instances.forEach(i => i.pos.forEach(v => assert(Number.isFinite(v), 'a NaN position')));
});

check('removing a middle part keeps the ones after it attached to the right thing', () => {
  const plan = validatePlan({
    title: 't', summary: '', steps: [
      { room: 'metal', action: 'weld', say: 'a', seconds: 3, part: { name: 'base', shape: 'box', material: 'metal', size: [0.6, 0.2, 0.6] } },
      { room: 'metal', action: 'weld', say: 'b', seconds: 3, part: { name: 'spacer', shape: 'box', material: 'metal', size: [0.3, 0.3, 0.3], attach: { to: 0, face: 'top' } } },
      { room: 'metal', action: 'weld', say: 'c', seconds: 3, part: { name: 'cap', shape: 'cone', material: 'metal', size: [0.4, 0.3, 0.4], attach: { to: 1, face: 'top' } } },
      { room: 'finished', action: 'present', say: 'done', seconds: 3 }
    ]
  }, 't');
  removePart(plan, 1);                       // the spacer in the middle
  const parts = planParts(plan);
  assert(parts.length === 2, 'wrong part count');
  assert(parts[1].name === 'cap', 'the wrong part was removed');
  assert(!parts[1].attach, 'the cap still points at the part that was scrapped');
  nothingFloats(solveAssembly(parts), 'middle removed');
});

check('the diff of a hand correction reads as a lesson', () => {
  const before = structuredClone(planParts(benchPlan()));
  const plan = benchPlan();
  editPart(plan, 2, { shape: 'cone', sy: 0.95 });
  editPart(plan, 1, { face: 'right' });
  const after = planParts(plan);

  const lessons = describeEdits(before, after);
  assert(lessons.length >= 2, `only ${lessons.length} lessons: ${lessons.join(' | ')}`);
  assert(lessons.some(l => /cone/.test(l) && /not a rod/.test(l)), 'the shape change was not described: ' + lessons.join(' | '));
  assert(lessons.some(l => /right/.test(l)), 'the reattachment was not described: ' + lessons.join(' | '));
  lessons.forEach(l => assert(l.length < 180 && /[.]$/.test(l), 'a lesson is not a sentence: ' + l));
});

check('a part added by hand is described as needed', () => {
  const before = structuredClone(planParts(benchPlan()));
  const plan = benchPlan();
  addPart(plan, { name: 'aerial', shape: 'rod', material: 'metal' });
  const lessons = describeEdits(before, planParts(plan));
  assert(lessons.some(l => /needs a aerial|needs an aerial|aerial/i.test(l)), 'the added part was not described: ' + lessons.join(' | '));
});

check('teaching by hand outranks anything the model signed off on its own', () => {
  const solved = solveAssembly(LAMP);
  let lib = [];
  ({ skills: lib } = learn(lib, { request: 'a desk lamp', plan: fakePlan, solved, reflection: fakeReflection, corrections: [], clean: true }));
  const modelConfidence = lib[0].confidence;

  ({ skills: lib } = learn(lib, {
    request: 'a desk lamp', plan: fakePlan, solved, reflection: fakeReflection,
    corrections: ['The shade has to be a cone, not a box.'], clean: false, taught: true
  }));
  assert(lib.length === 1, 'teaching created a duplicate skill');
  assert(lib[0].confidence > modelConfidence, 'a hand-corrected recipe is trusted no more than the model version');
  assert(lib[0].confidence >= 0.88, `taught confidence is only ${lib[0].confidence}`);
  assert(lib[0].stats.taught === 1, 'the correction was not counted');
  assert(lib[0].stats.uses === 1, 'teaching should not inflate the build count');
  assert(lib[0].lessons.some(l => /cone/.test(l)), 'the correction was not kept as a lesson');
});

check('a taught skill survives a round trip through disk', () => {
  const solved = solveAssembly(LAMP);
  let lib = [];
  ({ skills: lib } = learn(lib, {
    request: 'a desk lamp', plan: fakePlan, solved, reflection: fakeReflection,
    corrections: [], clean: false, taught: true
  }));
  const back = sanitize(JSON.parse(JSON.stringify(lib)));
  assert(back.length === 1, 'the skill did not survive');
  assert(back[0].confidence >= 0.88, 'confidence was lost');
  assert(back[0].stats.taught === 1, 'the taught count was lost');
  assert(back[0].taughtAt, 'the taught timestamp was lost');
});

/* ------------------------------------------------------------------ */
/* nudges — they must move the part, on every face                     */
/* ------------------------------------------------------------------ */
/* Measured against the PARENT, not against the world. The solver recentres
   the assembly on the pedestal and re-seats it on the ground, so moving one
   part shifts the whole frame — the meaningful quantity is where the part
   sits relative to the thing it is bolted to. */
const nudged = (face, patch) => {
  const s = solveAssembly([
    { name: 'body', shape: 'box', material: 'metal', size: [0.8, 0.8, 0.8] },
    { name: 'tab', shape: 'box', material: 'metal', size: [0.2, 0.2, 0.2], attach: { to: 0, face, ...patch } }
  ]);
  const [body, tab] = s.instances;
  return [0, 1, 2].map(ax => (tab.pos[ax] - body.pos[ax]) / (s.fit || 1));
};

check('every nudge moves the part, on every face', () => {
  for (const face of ['top', 'bottom', 'left', 'right', 'front', 'back']) {
    const base = nudged(face, {});
    for (const [key, ax] of [['dx', 0], ['dy', 1], ['dz', 2]]) {
      const moved = nudged(face, { [key]: 0.3 });
      const delta = moved[ax] - base[ax];
      assert(Math.abs(delta - 0.3) < 0.02,
        `${key} on the ${face} face moved the part ${delta.toFixed(3)}m, not 0.3m`);
      // and it must not have wandered on the other two axes
      for (const other of [0, 1, 2]) {
        if (other === ax) continue;
        assert(Math.abs(moved[other] - base[other]) < 0.02,
          `${key} on the ${face} face also shifted ${'xyz'[other]} by ${(moved[other] - base[other]).toFixed(3)}`);
      }
    }
  }
});

check('a nudge along a face normal is a standoff, not a no-op', () => {
  // this is the bug: dx on a left/right face used to be swallowed entirely
  const flush = nudged('left', {});
  const stood = nudged('left', { dx: -0.25 });
  assert(Math.abs(stood[0] - flush[0] + 0.25) < 0.02, 'dx on a left face still does nothing');

  const onTop = nudged('top', {});
  const lifted = nudged('top', { dy: 0.4 });
  assert(lifted[1] > onTop[1] + 0.35, 'dy on a top face was swallowed by gravity');
});

check('a mirrored pair on a side face lands one each side', () => {
  const s = solveAssembly([
    { name: 'torso', shape: 'box', material: 'metal', size: [0.6, 0.8, 0.4] },
    { name: 'arm', shape: 'rod', material: 'metal', size: [0.14, 0.62, 0.14], attach: { to: 0, face: 'left', dy: 0.1 }, array: { mode: 'mirror_x', count: 2, radius: 0.4 } }
  ]);
  const arms = s.instances.filter(i => i.name === 'arm');
  assert(arms.length === 2, `expected 2 arms, got ${arms.length}`);
  assert(arms[0].pos[0] < 0 && arms[1].pos[0] > 0,
    `both arms ended up on the same side: ${arms.map(a => a.pos[0].toFixed(2)).join(' and ')}`);
  assert(Math.abs(arms[0].pos[0] + arms[1].pos[0]) < 0.02, 'the pair is not symmetric');
  nothingBuried(s, 'mirrored arms');
});

check('a mirrored pair front and back lands one each end', () => {
  const s = solveAssembly([
    { name: 'body', shape: 'box', material: 'metal', size: [0.6, 0.4, 1.0] },
    { name: 'bumper', shape: 'panel', material: 'metal', size: [0.6, 0.3, 0.1], attach: { to: 0, face: 'front' }, array: { mode: 'mirror_z', count: 2, radius: 0.5 } }
  ]);
  const b = s.instances.filter(i => i.name === 'bumper');
  assert(b.length === 2 && b[0].pos[2] < 0 && b[1].pos[2] > 0,
    `bumpers at ${b.map(x => x.pos[2].toFixed(2)).join(' and ')}`);
});

check('nudges survive the whole edit path from the bench', () => {
  const plan = benchPlan();
  const mastOffset = p => {
    const s = solveAssembly(planParts(p));
    const mast = s.instances.find(i => i.name === 'mast');
    const chassis = s.instances.find(i => i.name === 'chassis');
    return (mast.pos[0] - chassis.pos[0]) / (s.fit || 1);
  };
  const before = mastOffset(plan);
  editPart(plan, 2, { dx: 0.35 });
  assert(planParts(plan)[2].attach.dx === 0.35, 'editPart dropped the nudge');
  const after = mastOffset(plan);
  assert(Math.abs(after - before - 0.35) < 0.02, `the mast moved ${(after - before).toFixed(3)}m, not 0.35m`);

  editPart(plan, 2, { dx: 0 });
  assert(planParts(plan)[2].attach.dx === undefined, 'setting a nudge back to zero left it on the part');
});

check('a hand-corrected recipe reaches the planner marked as authoritative', async () => {
  const { buildMessages } = agent;
  const solved = solveAssembly(LAMP);
  let lib = [];
  ({ skills: lib } = learn(lib, {
    request: 'a desk lamp', plan: fakePlan, solved, reflection: fakeReflection,
    corrections: ['The shade has to be a cone, not a box.'], clean: false, taught: true
  }));
  const hit = recall(lib, 'a bedside lamp');
  assert(hit, 'the taught skill was not recalled');

  const prompt = buildMessages('a bedside lamp', hit)[0].content;
  assert(/CORRECTED THIS ONE BY HAND/.test(prompt), 'the prompt does not say a person corrected it');
  assert(/NOT SUGGESTIONS/.test(prompt), 'the corrections are not marked as binding');
  assert(/cone/.test(prompt), 'the correction itself never made it into the prompt');
  assert(/part 0\s+base/.test(prompt), 'the proven part list is missing from the prompt');

  // and an ordinary learned skill must NOT claim a human signed it off
  let lib2 = [];
  ({ skills: lib2 } = learn(lib2, { request: 'a desk lamp', plan: fakePlan, solved, reflection: fakeReflection, corrections: [], clean: true }));
  const plain = buildMessages('a bedside lamp', recall(lib2, 'a bedside lamp'))[0].content;
  assert(!/CORRECTED THIS ONE BY HAND/.test(plain), 'a model-only recipe is being passed off as hand-checked');
});

/* ------------------------------------------------------------------ */
/* reference designs reach the prompt                                  */
/* ------------------------------------------------------------------ */
const REFS = [
  { source: 'thingiverse', title: 'Adjustable Phone Stand with Cable Slot', url: 'https://x/1', likes: 4200, tags: ['phone', 'stand', 'desk'], summary: 'A 60 degree back rest with a lip at the front.' },
  { source: 'thingiverse', title: 'Minimal Desk Phone Dock', url: 'https://x/2', likes: 900, tags: ['dock'], summary: '' },
  { source: 'printables', title: 'Foldable Travel Phone Stand', url: 'https://x/3', likes: 120, tags: [], summary: '' }
];

check('reference designs are folded into the planning prompt', () => {
  const { buildMessages, referenceBlock } = agent;
  const block = referenceBlock(REFS);
  assert(/Adjustable Phone Stand with Cable Slot/.test(block), 'a title was dropped');
  assert(/thingiverse, 4200 likes/.test(block), 'the provenance was dropped');
  assert(/tags: phone, stand, desk/.test(block), 'tags were dropped');
  assert(/60 degree back rest/.test(block), 'the description was dropped');

  const prompt = buildMessages('a phone stand', null, REFS)[0].content;
  assert(/HOW PEOPLE ACTUALLY MAKE THIS/.test(prompt), 'the reference block is not in the prompt');
  assert(/reference,\s+not\s+the\s+order/.test(prompt), 'nothing stops it copying the reference wholesale');
  // and it must still say what the shop can actually build
  assert(/HOW PARTS GO TOGETHER/.test(prompt), 'the geometry rules were displaced');
});

check('no references means no reference block, and nothing breaks', () => {
  const { buildMessages, referenceBlock } = agent;
  assert(referenceBlock([]) === '', 'an empty list still produced a block');
  assert(referenceBlock(null) === '', 'null still produced a block');
  for (const refs of [undefined, null, []]) {
    const prompt = buildMessages('a phone stand', null, refs)[0].content;
    assert(!/HOW PEOPLE ACTUALLY MAKE THIS/.test(prompt), 'an empty reference block leaked in');
    assert(/HOW PARTS GO TOGETHER/.test(prompt), 'the prompt lost its geometry rules');
  }
});

check('the inspector is told what a real one has', () => {
  const { buildCritiqueMessages } = agent;
  const plan = benchPlan();
  const withRefs = buildCritiqueMessages('a phone stand', plan, [], 'some parts', REFS)[0].content;
  assert(/WHAT A REAL ONE HAS/.test(withRefs), 'the inspector never sees the references');
  assert(/Adjustable Phone Stand/.test(withRefs), 'a reference title was dropped');

  const without = buildCritiqueMessages('a phone stand', plan, [], 'some parts')[0].content;
  assert(!/WHAT A REAL ONE HAS/.test(without), 'an empty reference section leaked in');
});

check('references and a recalled skill coexist in one prompt', () => {
  const { buildMessages } = agent;
  const solved = solveAssembly(LAMP);
  let lib = [];
  ({ skills: lib } = learn(lib, { request: 'a desk lamp', plan: fakePlan, solved, reflection: fakeReflection, corrections: [], clean: true }));
  const prompt = buildMessages('a desk lamp', recall(lib, 'a desk lamp'), REFS)[0].content;
  assert(/HOW PEOPLE ACTUALLY MAKE THIS/.test(prompt), 'references were lost');
  assert(/WHAT RIVET ALREADY KNOWS/.test(prompt), 'the recalled skill was lost');
  assert(prompt.indexOf('HOW PEOPLE ACTUALLY MAKE THIS') < prompt.indexOf('WHAT RIVET ALREADY KNOWS'),
    'what he learned should come after the references, so it is the last word');
});

/* ------------------------------------------------------------------ */
console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
