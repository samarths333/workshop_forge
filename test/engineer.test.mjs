/* The optimiser and the apprenticeship.

   Two things are being defended here, and they are not the obvious ones.

   For the optimiser it is FALSE POSITIVES. A rule that fires on a build
   that is fine is worse than no rule at all, because the first thing a
   person does with an optimiser that cries wolf is switch it off, and
   then the one time it was right about a topple nobody is listening. So
   every rule below is tested twice: once on a build with the fault, once
   on a build without it.

   For the apprenticeship it is GRINDING and DRIFT. An agent left alone
   will happily build the same stool four hundred times, and an agent that
   files its own unchecked output as ground truth gets worse the longer it
   runs. Both are tested by actually running the loop.

     node test/engineer.test.mjs
*/
import { analyse, applyFinding, applyAll, loadPath, tidyOrder, walkCost, summariseFindings } from '../renderer/optimize.js';
import { nextProject, shouldStudy, studyOutcome, CURRICULUM, STRETCH, STUDY_AFTER_MS } from '../renderer/apprentice.js';
import { learn, sanitize, SELF_TAUGHT_CEILING } from '../renderer/skills.js';
import { solveAssembly } from '../renderer/assembly.js';
import { assemblyMetrics } from '../renderer/metrics.js';
import { BAY_PITCH } from '../renderer/roles.js';
import { validatePlan, planParts, offlinePlan } from '../renderer/agent.js';
import { inspectPlan } from '../renderer/critic.js';

let pass = 0, fail = 0;
const out = [];
const check = (name, fn) => {
  try { fn(); pass++; out.push(`  ok    ${name}`); }
  catch (e) { fail++; out.push(`  FAIL  ${name}\n          ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

/* Build a plan the way the app does, so the optimiser is always looking at
   something that came through validatePlan — not a hand-made object with
   fields the real pipeline would have clamped. */
function planOf(parts, steps) {
  const p = validatePlan({
    title: 'test', summary: '',
    steps: (steps || parts.map((part, i) => ({
      room: 'metal', action: 'weld', say: `part ${i}`, seconds: 3, part
    })))
  }, 'test');
  return { plan: p, solved: inspectPlan(p).solved };
}
const ids = fs => fs.map(f => f.id);
const has = (fs, re) => fs.some(f => re.test(f.id));

/* A build with nothing wrong with it. Everything below that claims to be
   quiet on a good build is checked against this one. */
const GOOD = [
  { name: 'base', shape: 'cylinder', material: 'metal', size: [0.6, 0.12, 0.6] },
  { name: 'stem', shape: 'rod', material: 'metal', size: [0.16, 0.7, 0.16], attach: { to: 0, face: 'top' } },
  { name: 'shade', shape: 'cone', material: 'painted', size: [0.44, 0.3, 0.44], attach: { to: 1, face: 'top' } }
];

check('a sound build is left alone', () => {
  const { plan, solved } = planOf(GOOD);
  const f = analyse(plan, solved);
  const faults = f.filter(x => x.severity === 'fault');
  assert(!faults.length, `it invented ${faults.length} fault(s) in a good build: ${ids(faults)}`);
  assert(!has(f, /^topple|^thick|^slender|^buried|^array/), `false positives: ${ids(f)}`);
});

/* ================================================================== */
/* it falls over                                                       */
/* ================================================================== */
check('a build that topples is called out, and the fix actually fixes it', () => {
  const { plan, solved } = planOf([
    { name: 'foot', shape: 'box', material: 'metal', size: [0.2, 0.15, 0.2] },
    { name: 'slab', shape: 'box', material: 'metal', size: [1.6, 0.4, 0.5], attach: { to: 0, face: 'top', dx: 1.1, dy: 0.4 } }
  ]);
  const f = analyse(plan, solved);
  const topple = f.find(x => x.id === 'topple');
  assert(topple, `no topple finding: ${ids(f)}`);
  assert(topple.severity === 'fault', 'a build that falls over is a fault, not a suggestion');

  // and the patch has to do the job — an optimiser whose fix does not fix
  // it is worse than one that only complains
  const fixed = applyFinding(plan, topple);
  const after = assemblyMetrics(inspectPlan(fixed).solved);
  assert(after.stable, `still topples after applying the fix (tipRatio ${after.tipRatio.toFixed(2)})`);
});

check('a tall build on a proper base is not called a topple', () => {
  const { plan, solved } = planOf(GOOD);
  assert(!has(analyse(plan, solved), /^topple/), 'a lamp was told it falls over');
});

/* ================================================================== */
/* the load path                                                       */
/* ================================================================== */
check('what a part carries includes everything stacked on it', () => {
  const parts = [
    { name: 'base', shape: 'box', material: 'metal', size: [0.5, 0.2, 0.5] },
    { name: 'mid', shape: 'box', material: 'metal', size: [0.4, 0.4, 0.4], attach: { to: 0, face: 'top' } },
    { name: 'top', shape: 'box', material: 'metal', size: [0.3, 0.3, 0.3], attach: { to: 1, face: 'top' } }
  ];
  const { plan, solved } = planOf(parts);
  const carried = loadPath(planParts(plan), solved);
  assert(carried[0] > carried[1] && carried[1] > carried[2],
    `load does not accumulate downwards: ${carried.map(v => v.toFixed(1))}`);
  assert(carried[2] > 0, 'the top part carries at least itself');
});

check('something hung off a side face is not loading what it hangs from', () => {
  const { plan, solved } = planOf([
    { name: 'post', shape: 'box', material: 'metal', size: [0.4, 0.8, 0.4] },
    { name: 'sign', shape: 'panel', material: 'metal', size: [0.6, 0.4, 0.06], attach: { to: 0, face: 'left' } }
  ]);
  const carried = loadPath(planParts(plan), solved);
  // the post carries itself and nothing else — the sign hangs, it does not press
  const postAlone = 0.4 * 0.8 * 0.4 * 7850;
  assert(carried[0] < postAlone * 1.05, `the post is carrying ${carried[0].toFixed(0)}kg but weighs ${postAlone.toFixed(0)}kg — a hanging part is being counted as a load`);
});

check('cardboard under a tonne of steel is a fault, and swapping the material clears it', () => {
  const { plan, solved } = planOf([
    { name: 'card base', shape: 'box', material: 'cardboard', size: [0.6, 0.2, 0.6] },
    { name: 'anvil', shape: 'box', material: 'metal', size: [0.5, 0.5, 0.5], attach: { to: 0, face: 'top' } }
  ]);
  const f = analyse(plan, solved);
  const load = f.find(x => x.id.startsWith('load-'));
  assert(load, `no load-path finding: ${ids(f)}`);
  assert(/cardboard/.test(load.title), load.title);

  const fixed = applyFinding(plan, load);
  const again = analyse(fixed, inspectPlan(fixed).solved);
  assert(!has(again, /^load-0/), `still complaining after the material was changed: ${ids(again)}`);
});

check('cardboard holding up cardboard is fine', () => {
  const { plan, solved } = planOf([
    { name: 'box', shape: 'box', material: 'cardboard', size: [0.6, 0.3, 0.6] },
    { name: 'lid', shape: 'panel', material: 'cardboard', size: [0.6, 0.05, 0.6], attach: { to: 0, face: 'top' } }
  ]);
  assert(!has(analyse(plan, solved), /^load-/), 'a cardboard box was told it cannot hold its own lid');
});

/* ================================================================== */
/* material doing no work                                              */
/* ================================================================== */
check('a slab pretending to be a panel is flagged, with the mass it would save', () => {
  const { plan, solved } = planOf([
    { name: 'top', shape: 'box', material: 'wood', size: [1.2, 0.5, 0.9] }
  ]);
  const f = analyse(plan, solved);
  const thick = f.find(x => x.id.startsWith('thick-'));
  assert(thick, `no thickness finding: ${ids(f)}`);
  assert(/saves/.test(thick.gain), `the gain does not say what it saves: "${thick.gain}"`);
  assert(/\d/.test(thick.gain), 'the gain has no number in it');

  const fixed = applyFinding(plan, thick);
  const before = assemblyMetrics(solved).mass;
  const after = assemblyMetrics(inspectPlan(fixed).solved).mass;
  assert(after < before, `it got heavier: ${before} → ${after}`);
});

check('a proper panel is not told to go on a diet', () => {
  const { plan, solved } = planOf([
    { name: 'top', shape: 'box', material: 'wood', size: [1.2, 0.16, 0.9] }
  ]);
  assert(!has(analyse(plan, solved), /^thick-/), 'a 160mm plate over 1.2m was called too thick');

  // and a block is a block, not a fat plate
  const cube = planOf([{ name: 'anvil', shape: 'box', material: 'metal', size: [0.6, 0.6, 0.6] }]);
  assert(!has(analyse(cube.plan, cube.solved), /^thick-/), 'a cube was told to thin down');
});

check('a thick part that is actually carrying something is left alone', () => {
  const { plan, solved } = planOf([
    { name: 'block', shape: 'box', material: 'wood', size: [1.2, 0.5, 0.9] },
    { name: 'load', shape: 'box', material: 'metal', size: [0.6, 0.6, 0.6], attach: { to: 0, face: 'top' } }
  ]);
  assert(!has(analyse(plan, solved), /^thick-0/), 'a part was told to thin down while holding 700kg');
});

/* ================================================================== */
/* duplicate parts, buried parts, whiskers                             */
/* ================================================================== */
check('four identical legs written out four times become one array', () => {
  const leg = f => ({ name: 'leg', shape: 'rod', material: 'wood', size: [0.12, 0.6, 0.12], attach: { to: 0, face: 'bottom' } });
  const { plan, solved } = planOf([
    { name: 'top', shape: 'panel', material: 'wood', size: [1.1, 0.07, 0.8] },
    leg(), leg(), leg(), leg()
  ]);
  const f = analyse(plan, solved);
  const arr = f.find(x => x.id.startsWith('array-'));
  assert(arr, `four identical legs were not spotted: ${ids(f)}`);
  assert(/3 fewer trips/.test(arr.gain), `the gain should count the operations saved: "${arr.gain}"`);

  const fixed = applyFinding(plan, arr);
  const parts = planParts(fixed);
  assert(parts.length === 2, `${parts.length} parts after collapsing — should be the top and one leg`);
  assert(parts[1].array?.count === 4, `the survivor is not a 4-array: ${JSON.stringify(parts[1].array)}`);
  // and the thing still stands on four legs
  assert(inspectPlan(fixed).solved.instances.length === 5, 'the array did not expand back to four legs');
});

check('two of a thing is not a pattern', () => {
  const arm = () => ({ name: 'arm', shape: 'rod', material: 'metal', size: [0.1, 0.4, 0.1], attach: { to: 0, face: 'left' } });
  const { plan, solved } = planOf([
    { name: 'body', shape: 'box', material: 'metal', size: [0.5, 0.5, 0.4] }, arm(), arm()
  ]);
  assert(!has(analyse(plan, solved), /^array-/), 'a mirrored pair was called an array');
});

check('a part nobody can see is offered up for scrap', () => {
  const { plan, solved } = planOf([
    { name: 'shell', shape: 'box', material: 'metal', size: [1.2, 1.2, 1.2] },
    { name: 'pip', shape: 'box', material: 'metal', size: [0.16, 0.16, 0.16], attach: { to: 0, face: 'inside' } }
  ]);
  const f = analyse(plan, solved);
  const buried = f.find(x => x.id.startsWith('buried-'));
  assert(buried, `a part entirely inside another was not noticed: ${ids(f)}`);
  const fixed = applyFinding(plan, buried);
  assert(planParts(fixed).length === 1, 'scrapping it did not remove it');
});

check('a part merely touching another is not called buried', () => {
  const { plan, solved } = planOf(GOOD);
  assert(!has(analyse(plan, solved), /^buried-/), 'a stacked lamp part was called buried');
});

check('a whisker is flagged, a normal rod is not', () => {
  // validatePlan clamps a dimension to 150mm, so this is as thin as a part
  // can legally get — 2.5m of it on a 150mm section is a whisker
  const thin = planOf([{ name: 'wire', shape: 'box', material: 'metal', size: [0.1, 2.5, 0.1] }]);
  assert(has(analyse(thin.plan, thin.solved), /^slender-/), 'a 16:1 whisker was not flagged');
  const ok = planOf([{ name: 'post', shape: 'box', material: 'metal', size: [0.2, 1.4, 0.2] }]);
  assert(!has(analyse(ok.plan, ok.solved), /^slender-/), 'an ordinary post was called a whisker');
  // and a rod is never flagged — being thin is what a rod is
  const rod = planOf([{ name: 'stem', shape: 'rod', material: 'metal', size: [0.16, 1.6, 0.16] }]);
  assert(!has(analyse(rod.plan, rod.solved), /^slender-/), 'a rod was flagged for being rod-shaped');
});

/* ================================================================== */
/* the process                                                         */
/* ================================================================== */
check('a plan that crosses the shop pointlessly is spotted, and tidying keeps every part', () => {
  const steps = [
    { room: 'software', action: 'type', say: 'a', seconds: 3 },
    { room: 'metal', action: 'weld', say: 'b', seconds: 3, part: { name: 'p0', shape: 'box', material: 'metal', size: [0.4, 0.4, 0.4] } },
    { room: 'software', action: 'read_screen', say: 'c', seconds: 3 },
    { room: 'metal', action: 'grind', say: 'd', seconds: 3, part: { name: 'p1', shape: 'box', material: 'metal', size: [0.3, 0.3, 0.3], attach: { to: 0, face: 'top' } } },
    { room: 'software', action: 'mouse_click', say: 'e', seconds: 3 },
    { room: 'finished', action: 'assemble', say: 'f', seconds: 3 }
  ];
  const { plan, solved } = planOf(null, steps);
  const f = analyse(plan, solved);
  const thrash = f.find(x => x.id === 'thrash');
  assert(thrash, `${Math.round(0)} — the shop-crossing was not noticed: ${ids(f)}`);
  assert(/less on his feet/.test(thrash.gain), thrash.gain);

  const fixed = applyFinding(plan, thrash);
  assert(fixed.steps.length === plan.steps.length, 'tidying the order lost a step');
  const before = planParts(plan).map(p => p.name).join(',');
  assert(planParts(fixed).map(p => p.name).join(',') === before,
    'tidying reordered the parts — an attachment now points at the wrong thing');
});

check('parts keep their order no matter what, because attachments depend on it', () => {
  // every step makes a part: there is nothing safe to move, so nothing moves
  const parts = Array.from({ length: 6 }, (_, i) => ({
    name: `p${i}`, shape: 'box', material: 'metal', size: [0.3, 0.3, 0.3],
    ...(i ? { attach: { to: i - 1, face: 'top' } } : {})
  }));
  const { plan } = planOf(parts);
  const order = tidyOrder(plan.steps);
  const partSteps = order.filter(i => plan.steps[i].part);
  assert(partSteps.join() === [...partSteps].sort((a, b) => a - b).join(),
    'a part-making step was moved ahead of another one');
});

check('welding cardboard is a fault', () => {
  const { plan, solved } = planOf(null, [
    { room: 'metal', action: 'weld', say: 'x', seconds: 3, part: { name: 'card', shape: 'panel', material: 'cardboard', size: [0.5, 0.06, 0.5] } }
  ]);
  const f = analyse(plan, solved);
  assert(has(f, /^tool-/), `welding cardboard was allowed: ${ids(f)}`);
  assert(f.find(x => x.id.startsWith('tool-')).severity === 'fault', 'it should be a fault');
});

check('welding metal is not', () => {
  const { plan, solved } = planOf(null, [
    { room: 'metal', action: 'weld', say: 'x', seconds: 3, part: { name: 'plate', shape: 'panel', material: 'metal', size: [0.5, 0.06, 0.5] } }
  ]);
  assert(!has(analyse(plan, solved), /^tool-/), 'welding steel was called a mistake');
});

check('the walking is measured in real metres, off the real floor plan', () => {
  /* The walls came down and the stations moved. What matters is not the
     specific numbers but that the optimiser is reading the SAME plan the
     shop is built from — it used to keep its own copy, and priced every
     plan against a shop that had been demolished. */
  const P = BAY_PITCH;
  assert(walkCost('software', 'metal') === P, `${walkCost('software', 'metal')}m from the spec desk to the forge`);
  assert(walkCost('software', 'electronics') === P * 4, `${walkCost('software', 'electronics')}m end to end`);
  assert(walkCost('metal', 'metal') === 0, 'standing still costs nothing');
  // the assembly bay is in the middle, which is the whole point of the
  // layout — nothing is further from it than half the shop
  for (const k of ['software', 'metal', 'cardboard', 'electronics']) {
    assert(walkCost(k, 'finished') <= P * 2, `${k} is ${walkCost(k, 'finished')}m from the bay`);
  }
  assert(walkCost('metal', 'finished') === P && walkCost('cardboard', 'finished') === P,
    'the two heavy fabrication stations are not next to the bay');
});

check('findings are ordered faults first and summarised in one line', () => {
  const { plan, solved } = planOf([
    { name: 'card base', shape: 'box', material: 'cardboard', size: [0.6, 0.2, 0.6] },
    { name: 'anvil', shape: 'box', material: 'metal', size: [0.5, 0.5, 0.5], attach: { to: 0, face: 'top' } },
    { name: 'slab', shape: 'panel', material: 'wood', size: [1.2, 0.5, 0.9], attach: { to: 1, face: 'top' } }
  ]);
  const f = analyse(plan, solved);
  const firstImprovement = f.findIndex(x => x.severity === 'improvement');
  const lastFault = f.map(x => x.severity).lastIndexOf('fault');
  assert(firstImprovement === -1 || lastFault < firstImprovement, `not sorted: ${f.map(x => x.severity)}`);
  assert(/fault|improvement/.test(summariseFindings(f)), summariseFindings(f));
  assert(summariseFindings([]) === 'nothing worth changing', summariseFindings([]));
});

check('every finding carries something a person can act on', () => {
  const { plan, solved } = planOf([
    { name: 'card base', shape: 'box', material: 'cardboard', size: [0.6, 0.2, 0.6] },
    { name: 'anvil', shape: 'box', material: 'metal', size: [0.5, 0.5, 0.5], attach: { to: 0, face: 'top' } }
  ]);
  for (const f of analyse(plan, solved)) {
    assert(f.title && f.why && f.gain, `${f.id} is missing its sentence`);
    assert(f.title.length < 90, `${f.id} title is a paragraph`);
    assert(['fault', 'improvement', 'note'].includes(f.severity), `${f.id} has severity ${f.severity}`);
  }
});

check('an empty bench produces no findings rather than throwing', () => {
  assert(analyse(null, null).length === 0, 'nothing should come back');
  assert(analyse({ steps: [] }, { instances: [] }).length === 0, 'nothing should come back');
});

/* ================================================================== */
/* the apprenticeship                                                  */
/* ================================================================== */
check('with an empty library he starts at the bottom of the ladder', () => {
  const p = nextProject({ skills: [], done: [] });
  assert(p.request === CURRICULUM[0].request, `he started with "${p.request}"`);
  assert(p.kind === 'gap' && p.why, 'no reason given');
});

check('he goes back to the class he keeps getting wrong before learning anything new', () => {
  const skills = [{
    class: 'lamp', confidence: 0.34, recipe: { parts: [{ name: 'base' }] },
    sourceRequests: ['a desk lamp with a cone shade'], stats: { uses: 3 }
  }];
  const p = nextProject({ skills, done: [] });
  assert(p.kind === 'repair', `he chose to ${p.kind} instead of repairing a 34% lamp`);
  assert(/lamp/.test(p.request), p.request);
});

check('he does not practise over something a person taught him', () => {
  const skills = [{
    class: 'lamp', confidence: 0.4, recipe: { parts: [{ name: 'base' }] },
    sourceRequests: ['a desk lamp'], stats: { uses: 2, taught: 1 }
  }];
  const p = nextProject({ skills, done: [] });
  assert(p.kind !== 'repair', 'he tried to practise over a hand-taught skill');
});

check('he never grinds the same project', () => {
  // run the loop the way the app does: pick, mark done, pick again
  const skills = [];
  const done = [];
  const picks = [];
  for (let i = 0; i < 40; i++) {
    const p = nextProject({ skills, done });
    if (!p) break;
    picks.push(p.request);
    done.push(p.request);
    // pretend each one succeeded and became a skill
    const cls = p.request.split(' ').at(-1);
    if (!skills.some(s => s.class === cls)) {
      skills.push({ class: cls, confidence: 0.55, recipe: { parts: [{ name: 'x' }] }, sourceRequests: [p.request], stats: { uses: 1 } });
    }
  }
  assert(picks.length > 12, `he ran out of ideas after ${picks.length} projects`);
  // no repeat within the cooldown window
  for (let i = 0; i < picks.length; i++) {
    const window = picks.slice(Math.max(0, i - 6), i);
    assert(!window.includes(picks[i]), `he built "${picks[i]}" twice inside the cooldown`);
  }
  // the first dozen must be entirely fresh ground — repeating only becomes
  // legitimate once he has genuinely run out of new things to try
  const first = picks.slice(0, 12);
  assert(new Set(first).size === first.length, `he repeated himself inside the first dozen: ${first}`);
});

check('once the ladder is done he goes after engineering, then variations', () => {
  const skills = CURRICULUM.map(c => ({
    class: c.request.split(' ').at(-1), confidence: 0.7,
    recipe: { parts: [{ name: 'x' }] }, sourceRequests: [c.request], stats: { uses: 2 }
  }));
  const p = nextProject({ skills, done: [] });
  assert(p.kind === 'stretch', `after the whole curriculum he chose to ${p.kind}`);
  assert(STRETCH.some(s => s.request === p.request), p.request);

  // and with every domain done too, he starts varying what he knows
  const all = [...skills, ...STRETCH.map(s => ({
    class: s.request.split(' ').at(-1), confidence: 0.7,
    recipe: { parts: [{ name: 'x' }] }, sourceRequests: [s.request], stats: { uses: 2 }
  }))];
  const v = nextProject({ skills: all, done: [] });
  assert(v?.kind === 'vary', `he chose ${v?.kind} instead of testing what he knows`);
});

check('he can take a target from what a lookup turned up', () => {
  const skills = [...CURRICULUM, ...STRETCH].map(c => ({
    class: c.request.split(' ').at(-1), confidence: 0.9,
    recipe: { parts: [] }, sourceRequests: [c.request], stats: { uses: 2, taught: 1 }
  }));
  const p = nextProject({
    skills, done: [],
    refs: [{ title: 'Articulated Desk Organiser v3 (no supports!)' }]
  });
  // nothing has a recipe, so vary cannot fire — the world is the last resort
  assert(p?.kind === 'world', `he chose ${p?.kind}`);
  assert(!/v3|\(|!/.test(p.request), `the sales pitch came through: "${p.request}"`);
  assert(p.request.split(' ').length <= 5, `too long to be a request: "${p.request}"`);
});

/* ================================================================== */
/* when he is allowed to start                                         */
/* ================================================================== */
check('he waits for a properly idle shop', () => {
  const base = { on: true, busy: false, idleMs: STUDY_AFTER_MS + 1, benchOpen: false, typing: false, studying: false };
  assert(shouldStudy(base), 'an idle shop with study on should start');
  assert(!shouldStudy({ ...base, on: false }), 'he started with study switched off');
  assert(!shouldStudy({ ...base, busy: true }), 'he started a project mid-build');
  assert(!shouldStudy({ ...base, benchOpen: true }), 'he started while the bench was open');
  assert(!shouldStudy({ ...base, typing: true }), 'he started while someone was typing');
  assert(!shouldStudy({ ...base, studying: true }), 'he started a second project on top of the first');
  assert(!shouldStudy({ ...base, idleMs: 1000 }), 'he started after one second of quiet');
});

/* ================================================================== */
/* and the thing that stops the library rotting                        */
/* ================================================================== */
check('a study build that came out sound is worth less than one a person watched', () => {
  const sound = studyOutcome({ issues: [], metrics: { stable: true }, findings: [] });
  assert(sound.sound && sound.keepRecipe, 'a clean study build was rejected');
  assert(sound.confidence <= SELF_TAUGHT_CEILING, `${sound.confidence} is above the ceiling`);
  assert(sound.confidence < 0.88, 'self-study reached hand-taught confidence');
});

check('a study build that falls over files lessons and no recipe', () => {
  const bad = studyOutcome({
    issues: [], metrics: { stable: false },
    findings: [{ severity: 'fault', title: 'It falls over', why: 'the mass is outside the base' }]
  });
  assert(!bad.sound && !bad.keepRecipe, 'a build that topples was filed as a recipe');
  assert(bad.lessons.length, 'it learned nothing at all from failing');
  assert(/falls over/.test(bad.note), bad.note);
});

check('practising never overwrites what a person taught', () => {
  const taught = learn([], {
    request: 'a desk lamp', plan: { title: 'lamp', steps: [] }, solved: null,
    reflection: { object_class: 'lamp', name: 'Desk lamp', roles: [], lessons: ['the shade is a cone'] },
    corrections: [], clean: true, taught: true
  });
  const before = taught.skill.recipe;
  assert(taught.skill.confidence === 0.88, `hand-taught filed at ${taught.skill.confidence}`);

  const after = learn(taught.skills, {
    request: 'a desk lamp',
    plan: { title: 'lamp', steps: [{ room: 'metal', action: 'weld', say: 'x', seconds: 3, part: { name: 'blob', shape: 'box', material: 'metal', size: [1, 1, 1] } }] },
    solved: null,
    reflection: { object_class: 'lamp', name: 'Lamp', roles: [], lessons: ['a blob is fine'] },
    corrections: [], clean: true, self: true, keepRecipe: true
  });
  assert(JSON.stringify(after.skill.recipe) === JSON.stringify(before),
    'a study build overwrote a hand-taught recipe');
  assert(after.skill.confidence === 0.88, `confidence moved to ${after.skill.confidence}`);
  assert(after.skill.stats.studied === 1, 'the study was not recorded');
});

check('a failed study build leaves no geometry behind', () => {
  const r = learn([], {
    request: 'a truss bridge', plan: { title: 'bridge', steps: [] }, solved: null,
    reflection: { object_class: 'bridge', name: 'Bridge', roles: [], lessons: ['it fell over'] },
    corrections: [], clean: false, self: true, keepRecipe: false
  });
  assert(!r.skill.recipe.parts.length, 'a failed study build filed a recipe anyway');
  assert(r.skill.lessons.length, 'and it learned nothing from failing');
});

check('a night of practice cannot push a class past the ceiling', () => {
  let skills = [];
  for (let i = 0; i < 50; i++) {
    ({ skills } = learn(skills, {
      request: 'a stool', plan: { title: 'stool', steps: [] }, solved: null,
      reflection: { object_class: 'stool', name: 'Stool', roles: [], lessons: [] },
      corrections: [], clean: true, self: true, keepRecipe: true
    }));
  }
  const s = skills.find(x => x.class === 'stool');
  assert(s.confidence <= SELF_TAUGHT_CEILING + 1e-9,
    `fifty unsupervised builds got it to ${s.confidence} — the ceiling is not holding`);
  assert(s.stats.studied === 50, `studied count is ${s.stats.studied}`);
});

check('the studied count survives a trip through the skill file', () => {
  const [s] = sanitize([{
    class: 'stool', recipe: { parts: [], process: [] }, confidence: 0.5,
    stats: { uses: 3, studied: 7 }
  }]);
  assert(s.stats.studied === 7, 'the studied count was dropped on load');
});

/* ================================================================== */
/* the whole loop, offline                                             */
/* ================================================================== */
check('a study project goes all the way through with nothing reachable', () => {
  const pick = nextProject({ skills: [], done: [] });
  const plan = validatePlan(offlinePlan(pick.request, null), pick.request);
  const report = inspectPlan(plan);
  const findings = analyse(plan, report.solved);
  const outcome = studyOutcome({
    issues: report.issues, metrics: assemblyMetrics(report.solved), findings
  });
  const { skill } = learn([], {
    request: pick.request, plan, solved: report.solved,
    reflection: { object_class: 'stool', name: 'Stool', roles: [], lessons: outcome.lessons },
    corrections: [], clean: !report.issues.length, self: true, keepRecipe: outcome.keepRecipe
  });
  assert(skill.class === 'stool', `filed as ${skill.class}`);
  assert(skill.confidence <= SELF_TAUGHT_CEILING, `filed at ${skill.confidence}`);
  assert(typeof outcome.note === 'string' && outcome.note.length, 'no explanation of what happened');
});

/* ================================================================== */
console.log(out.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
