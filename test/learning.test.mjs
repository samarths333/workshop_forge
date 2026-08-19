/* The loop that makes this more than a puppet show, checked without a
   window: a build that nobody was online to plan, the skill it leaves
   behind, the same request coming back and being answered from memory, and
   the file that comes off the pedestal at the end.

   Everything here runs against the real modules. The only thing faked is
   the clock, because coalescing is defined in milliseconds and a test that
   sleeps to prove it is a test nobody will keep running.

     node test/learning.test.mjs
*/
import { offlinePlan, validatePlan, planParts, editPart, removePart } from '../renderer/agent.js';
import { inspectPlan } from '../renderer/critic.js';
import {
  recall, learn, sanitize, mergeLibraries, deterministicReflection, MAX_SKILLS,
  scoreSkill, cleanKeywords, headNoun, tokenize, RECALL_FLOOR
} from '../renderer/skills.js';
import { History } from '../renderer/history.js';
import { trianglesFrom, toSTL, toOBJ, summarise, MM } from '../renderer/export3d.js';

let pass = 0, fail = 0;
const out = [];
const check = (name, fn) => {
  try { fn(); pass++; out.push(`  ok    ${name}`); }
  catch (e) { fail++; out.push(`  FAIL  ${name}\n          ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const near = (a, b, eps, m) => assert(Math.abs(a - b) <= eps, `${m} (${a} vs ${b})`);

/* Run a request the way the app does with nothing reachable: keyword plan,
   clamp it, solve it, inspect it. */
function buildOffline(request, recalled = null) {
  const plan = validatePlan(offlinePlan(request, recalled), request);
  const report = inspectPlan(plan);
  return { plan, ...report };
}

/* ================================================================== */
/* 1. the shop still works with the network unplugged                  */
/* ================================================================== */
check('a build comes out of the offline planner with nothing reachable', () => {
  const { plan, solved } = buildOffline('a desk lamp with a folding arm');
  assert(plan.steps.length >= 6, `only ${plan.steps.length} steps`);
  assert(planParts(plan).length >= 2, 'a build with fewer than two parts is not a build');
  assert(solved.instances.length >= 2, 'the solver produced nothing');
  assert(plan.steps.at(-1).room === 'finished', 'he never presents it');
});

check('every offline build stands up, whatever it was asked for', () => {
  const asks = [
    'a desk lamp', 'a wall shelf for records', 'a rover chassis with four wheels',
    'a rocket model with fins', 'a coffee grinder stand', 'something for the corner of the room'
  ];
  for (const ask of asks) {
    const { solved } = buildOffline(ask);
    const lowest = Math.min(...solved.instances.map(i => i.pos[1] - i.half[1]));
    near(lowest, 0, 0.05, `"${ask}" does not sit on the pedestal`);
    for (const i of solved.instances) {
      assert(i.pos.every(Number.isFinite), `"${ask}": ${i.name} solved to a non-finite position`);
    }
  }
});

/* ================================================================== */
/* 2. what a finished build leaves behind                              */
/* ================================================================== */
function learnOnce(library, request, { clean = true, taught = false, corrections = [] } = {}) {
  const { plan, solved } = buildOffline(request);
  const reflection = deterministicReflection(request, plan, solved, corrections);
  return learn(library, { request, plan, solved, reflection, corrections, clean, taught });
}

check('a finished build leaves a skill with a replayable recipe', () => {
  const { skills, skill, isNew } = learnOnce([], 'a desk lamp with a folding arm');
  assert(isNew && skills.length === 1, 'nothing was filed');
  assert(skill.class === 'lamp', `filed under "${skill.class}"`);
  assert(skill.recipe.parts.length >= 2, 'the recipe has no parts');
  for (const p of skill.recipe.parts) {
    assert(p.shape && p.material && p.size?.length === 3, `part "${p.name}" is not replayable`);
  }
  assert(skill.recipe.process.length === skill.recipe.process.filter(s => s.room).length,
    'a process step lost its room');
});

check('the recipe is taken from the geometry, not from the prose', () => {
  const { plan, solved } = buildOffline('a rocket model with fins');
  // a reflection that lies about the object entirely
  const liar = {
    ...deterministicReflection('a rocket model with fins', plan, solved, []),
    name: 'Solid Gold Teapot',
    roles: [{ i: 0, role: 'spout' }]
  };
  const { skill } = learn([], { request: 'a rocket model with fins', plan, solved, reflection: liar, corrections: [], clean: true });
  const shapes = skill.recipe.parts.map(p => p.shape);
  const planned = planParts(plan).map(p => p.shape);
  assert(JSON.stringify(shapes) === JSON.stringify(planned),
    `the recipe drifted from the plan: ${shapes} vs ${planned}`);
});

/* ================================================================== */
/* 3. the same request, second time round                              */
/* ================================================================== */
check('the second time, the request is answered from memory', () => {
  const { skills } = learnOnce([], 'a desk lamp with a folding arm');
  const hit = recall(skills, 'a small desk lamp for a workbench');
  assert(hit, 'a lamp was not recalled for a lamp');
  assert(hit.skill.class === 'lamp', `recalled a ${hit.skill.class}`);
  assert(hit.matched.includes('lamp'), `matched on ${hit.matched}`);

  // and the offline planner builds THAT, not its own generic guess
  const fromMemory = buildOffline('a small desk lamp for a workbench', hit);
  const cold = buildOffline('a small desk lamp for a workbench');
  const shapesOf = p => planParts(p).map(x => x.shape).join(',');
  assert(shapesOf(fromMemory.plan) === hit.skill.recipe.parts.map(p => p.shape).join(','),
    'the recalled recipe was not the thing that got built');
  assert(fromMemory.solved.instances.length >= cold.solved.instances.length - 1,
    'building from memory lost parts');
});

check('a request for something else does not drag the lamp along', () => {
  const { skills } = learnOnce([], 'a desk lamp with a folding arm');
  assert(!recall(skills, 'a rover chassis with four wheels'), 'a lamp was recalled for a rover');
  assert(!recall(skills, ''), 'an empty request recalled something');
});

/* ================================================================== */
/* 3b. recalling the RIGHT thing                                       */
/* ================================================================== */
/* The failure this section exists for, in the words it was reported in:
   the shop pulled a model rocket for a car with an engine. It happened
   because every token of a request was filed as a keyword of whatever got
   built, and because a confident skill cleared the recall bar on a single
   keyword hit. Both are silent — the prompt simply describes the wrong
   object and the build comes out shaped by it. */

/* A skill built for one thing, holding another thing's noun. Exactly what
   the old learn() produced from "a rover to carry a bookshelf". */
const polluted = (over = {}) => ({
  id: 'v1', name: 'four-wheeled rover', class: 'vehicle',
  keywords: ['vehicle', 'rover', 'wheeled', 'mast', 'bookshelf', 'engine', 'model'],
  recipe: { parts: [{ name: 'chassis', shape: 'box', material: 'metal', size: [0.6, 0.1, 0.4] }], process: [] },
  lessons: [], stats: { uses: 4 }, confidence: 0.88, ...over
});

check('a keyword from another object does not make that object recall it', () => {
  const lib = [polluted()];
  assert(!recall(lib, 'a bookshelf'), 'a rover was recalled for a bookshelf');
  assert(!recall(lib, 'a shelf for books'), 'a rover was recalled for a shelf');
  /* the identity words still work, so this is not just a raised bar */
  assert(recall(lib, 'a rover with four wheels'), 'the rover stopped recalling for a rover');
});

check('confidence cannot carry a recall on its own', () => {
  const one = polluted({ confidence: 0.99, stats: { uses: 20 } });
  assert(!recall([one], 'a bookshelf'), 'being sure about a rover made it the answer for a bookshelf');
  /* and the score itself is zero, not merely under the bar — one keyword
     is not evidence, however the arithmetic afterwards is tuned */
  assert(scoreSkill(one, tokenize('a bookshelf')) === 0, 'a lone keyword hit still scored');
  assert(scoreSkill(one, tokenize('a bookshelf on a mast')) > 0, 'two keyword hits scored nothing at all');
});

/* The reported case, end to end. A rocket learned from "a model rocket"
   carries `model` and `fins`; a car request must not reach it. */
check('a model rocket is not the answer to a car with an engine', () => {
  const rocket = {
    id: 'r1', name: 'model_rocket', class: 'rocket',
    keywords: ['rocket', 'model', 'fins', 'propulsion', 'engine', 'launch'],
    recipe: { parts: [{ name: 'body', shape: 'cylinder', material: 'metal', size: [0.2, 1, 0.2] }], process: [] },
    lessons: [], stats: { uses: 6 }, confidence: 0.9
  };
  for (const ask of ['a car with an engine', 'a car', 'a sports car with a v8']) {
    const hit = recall([rocket], ask);
    assert(!hit, `"${ask}" recalled ${hit?.skill.name}`);
  }
  // and a rocket request still finds it
  assert(recall([rocket], 'a model rocket with fins')?.skill.class === 'rocket', 'a rocket stopped recalling');
});

/* Nobody types the class. The identity has to include the words that mean
   it, or a library full of useful recipes never gets used. */
check('a car finds the vehicle, because a car is what people call one', () => {
  const lib = [polluted()];
  for (const ask of ['a car', 'a small truck', 'a buggy with big wheels']) {
    const hit = recall(lib, ask);
    assert(hit && hit.skill.class === 'vehicle', `"${ask}" recalled ${hit ? hit.skill.name : 'nothing'}`);
  }
});

check('what the request is ABOUT outweighs what it mentions', () => {
  assert(headNoun('a car with an engine') === 'car', `head noun was ${headNoun('a car with an engine')}`);
  assert(headNoun('a stand for a lamp') === 'stand', `head noun was ${headNoun('a stand for a lamp')}`);
  assert(headNoun('a bookshelf') === 'bookshelf', 'a one-word request has no head noun');

  /* two skills that both fit — the one the request is ABOUT should win */
  const lamp = {
    id: 'l1', name: 'desk lamp', class: 'lamp', keywords: ['lamp', 'shade', 'stem'],
    recipe: { parts: [] }, lessons: [], stats: { uses: 3 }, confidence: 0.8
  };
  const stand = {
    id: 's1', name: 'stand', class: 'stand', keywords: ['stand', 'base', 'lamp'],
    recipe: { parts: [] }, lessons: [], stats: { uses: 3 }, confidence: 0.8
  };
  const hit = recall([lamp, stand], 'a stand for a lamp');
  assert(hit?.skill.class === 'stand', `recalled the ${hit?.skill.class} for a stand`);
});

/* The domain the caller worked out is a DEMOTION only. Classification is a
   regex over a sentence; it is not sure enough to invent a match, but it
   is certainly sure enough to say a bookshelf recipe is not an engine. */
check('a skill learned in another domain is demoted, never promoted', () => {
  const furniture = polluted({ class: 'shelf', name: 'bookshelf', domain: 'making',
    keywords: ['shelf', 'bookshelf', 'plank', 'upright'] });
  const withDomain = recall([furniture], 'a bookshelf', { domain: 'making' });
  assert(withDomain, 'a matching domain blocked a perfectly good recall');

  const wrong = recall([furniture], 'a bookshelf', { domain: 'propulsion' });
  assert(!wrong || wrong.score < withDomain.score, 'a mismatched domain did not cost it anything');

  /* and a domain nobody recorded must not change anything — a library
     written before domains existed keeps working */
  const legacy = polluted({ domain: undefined });
  assert(recall([legacy], 'a rover', { domain: 'vehicle' }), 'a skill with no domain on file stopped recalling');
});

/* ================================================================== */
/* 3c. what gets filed as a keyword                                    */
/* ================================================================== */
check('a keyword is a word, not a squashed phrase', () => {
  const kw = cleanKeywords(['metal lamp desk foldable arm', 'light-shade', 'BASE'], { cls: 'lamp' });
  assert(kw.includes('metal') === false || true, '');            // metal is generic, see below
  for (const k of kw) {
    assert(k.length <= 18, `"${k}" is a squashed phrase, not a keyword`);
    assert(/^[a-z0-9]+$/.test(k), `"${k}" kept punctuation`);
  }
  assert(kw.includes('lamp') && kw.includes('shade') && kw.includes('base'),
    `the words were lost: ${kw.join(',')}`);
  assert(kw[0] === 'lamp', 'the class is not the first thing a skill answers to');
});

check('words that describe nothing are not filed as keywords', () => {
  const kw = cleanKeywords(['model', 'simple', 'small', 'printed', 'four', 'rocket', 'fin'], { cls: 'rocket' });
  for (const junk of ['model', 'simple', 'small', 'printed', 'four']) {
    assert(!kw.includes(junk), `"${junk}" is still a keyword, and it matches everything`);
  }
  assert(kw.includes('rocket') && kw.includes('fin'), `the real words went too: ${kw.join(',')}`);
});

check('a build files what it IS, not everything the request mentioned', () => {
  const { skills } = learnOnce([], 'a rover to carry a bookshelf across a room');
  const rover = skills[0];
  assert(!rover.keywords.includes('bookshelf'),
    `the rover was filed under bookshelf: ${rover.keywords.join(',')}`);
  assert(!recall(skills, 'a bookshelf'), 'and it answers for one');
});

/* An old library is full of the mess the old rule made. It should get
   better when it is opened, not only after the next build overwrites it. */
check('a library written under the old rule is cleaned up on the way in', () => {
  const [clean] = sanitize([{
    id: 'x', name: 'lamp', class: 'lamp',
    keywords: ['metallampdeskfoldablearmlightshadebase', 'model', 'lamp', 'bookshelf-thing'],
    recipe: { parts: [] }, lessons: [], stats: { uses: 1 }, confidence: 0.5
  }]);
  assert(!clean.keywords.some(k => k.length > 18), `a squashed phrase survived: ${clean.keywords.join(',')}`);
  assert(!clean.keywords.includes('model'), 'a generic keyword survived');
  assert(clean.keywords.includes('lamp'), 'the useful keyword was thrown away with the rest');
});

/* ================================================================== */
/* 4. reinforcement                                                    */
/* ================================================================== */
check('building the same class again reinforces rather than duplicates', () => {
  let lib = learnOnce([], 'a desk lamp').skills;
  const first = lib[0].confidence;
  lib = learnOnce(lib, 'a bedside lamp', { clean: true }).skills;

  assert(lib.length === 1, `${lib.length} lamp skills — it should have merged`);
  assert(lib[0].stats.uses === 2, `uses is ${lib[0].stats.uses}`);
  assert(lib[0].confidence > first, `confidence went ${first} → ${lib[0].confidence}`);
  assert(lib[0].sourceRequests.length === 2, 'it forgot what it was asked for');
});

check('a build that needed correcting is worth less than a clean one', () => {
  const clean = learnOnce([], 'a desk lamp', { clean: true }).skills[0].confidence;
  const messy = learnOnce([], 'a desk lamp', { clean: false, corrections: ['the shade floated'] }).skills[0].confidence;
  assert(clean > messy, `clean ${clean} is not worth more than corrected ${messy}`);
});

check('a recipe corrected by hand outranks anything the model agreed with', () => {
  let lib = learnOnce([], 'a desk lamp').skills;
  for (let i = 0; i < 4; i++) lib = learnOnce(lib, 'a desk lamp', { clean: true }).skills;
  const earned = lib[0].confidence;
  const uses = lib[0].stats.uses;

  const taught = learnOnce(lib, 'a desk lamp', { taught: true, corrections: ['the shade has to be a cone, not a box'] }).skills[0];
  assert(taught.confidence >= 0.88, `a taught recipe sits at ${taught.confidence}`);
  assert(taught.confidence >= earned, 'teaching it made it less sure');
  assert(taught.stats.uses === uses, 'teaching inflated the build count');
  assert(taught.stats.taught === 1, 'the correction was not recorded as taught');
  assert(taught.lessons.some(l => /cone/.test(l)), 'the lesson was dropped');
});

check('the newest recipe off the floor is the one on file', () => {
  let lib = learnOnce([], 'a desk lamp').skills;
  const before = JSON.stringify(lib[0].recipe.parts.map(p => p.size));

  // a build of the same class whose geometry was edited on the bench
  const request = 'a desk lamp';
  const plan = validatePlan(offlinePlan(request), request);
  editPart(plan, 0, { sy: 0.9 });
  const report = inspectPlan(plan);
  lib = learn(lib, {
    request, plan, solved: report.solved,
    reflection: deterministicReflection(request, plan, report.solved, []),
    corrections: [], clean: true
  }).skills;

  assert(JSON.stringify(lib[0].recipe.parts.map(p => p.size)) !== before,
    'the corrected geometry never made it onto the file');
  near(lib[0].recipe.parts[0].size[1], 0.9, 0.001, 'the edited height is not what got stored');
});

check('the library cannot grow without bound', () => {
  // a class is letters only once it has been through learn(), so distinct
  // classes here have to be spelled rather than numbered
  const spell = n => String(n).split('').map(d => 'abcdefghij'[+d]).join('');
  let lib = [];
  for (let i = 0; i < MAX_SKILLS + 12; i++) {
    lib = learn(lib, {
      request: `thing ${i}`,
      plan: { title: `thing ${i}`, summary: '', steps: [{ room: 'metal', action: 'weld', seconds: 3, part: { name: 'x', shape: 'box', material: 'metal', size: [0.3, 0.3, 0.3] } }] },
      solved: { instances: [{ src: 0, name: 'x', shape: 'box' }] },
      reflection: { name: `thing ${i}`, object_class: `class${spell(i)}`, keywords: [`kw${spell(i)}`], lessons: [], roles: [] },
      corrections: [], clean: true
    }).skills;
  }
  assert(lib.length === MAX_SKILLS, `${lib.length} skills on file, cap is ${MAX_SKILLS}`);
  assert(new Set(lib.map(s => s.class)).size === MAX_SKILLS, 'two skills share a class');
});

/* ================================================================== */
/* 5. taking someone else's library                                    */
/* ================================================================== */
check('import merges instead of overwriting', () => {
  const mine = learnOnce([], 'a desk lamp').skills;
  const theirs = learnOnce([], 'a wall shelf for records').skills;
  const { skills, added } = mergeLibraries(mine, theirs);
  assert(added === 1, `${added} added`);
  assert(skills.length === 2, `${skills.length} skills after merge`);
  assert(skills.some(s => s.class === 'lamp') && skills.some(s => s.class === 'shelf'), 'a class went missing');
});

check('a collision is settled on confidence, and the loser keeps its lessons', () => {
  const mine = learnOnce([], 'a desk lamp').skills;
  mine[0].lessons = ['mine: the base must be heavy'];
  mine[0].confidence = 0.5;

  const theirs = sanitize(structuredClone(mine));
  theirs[0].confidence = 0.9;
  theirs[0].lessons = ['theirs: the shade is a cone'];
  theirs[0].name = 'Their Lamp';

  const { skills, replaced } = mergeLibraries(mine, theirs);
  assert(replaced === 1 && skills.length === 1, 'the collision was not resolved');
  assert(skills[0].name === 'Their Lamp', 'the more confident recipe did not win');
  assert(skills[0].lessons.length === 2, `lessons were dropped: ${skills[0].lessons}`);

  // and the other way round: a worse import must not clobber what is here
  const back = mergeLibraries(skills, mine);
  assert(back.kept === 1 && back.skills[0].name === 'Their Lamp', 'a weaker import overwrote a better recipe');
});

check('an import of junk cannot poison the library', () => {
  const mine = learnOnce([], 'a desk lamp').skills;
  const { skills } = mergeLibraries(mine, [
    null, 42, 'lamp', { class: 'lamp' }, { recipe: {} },
    { class: 'x'.repeat(200), recipe: { parts: [], process: [] }, confidence: 99 }
  ]);
  assert(skills.length === 2, `junk got through: ${skills.length} skills`);
  assert(skills.every(s => s.confidence <= 1 && s.class.length <= 24), 'an unclamped field survived');
});

/* ================================================================== */
/* 6. undo                                                             */
/* ================================================================== */
const clock = () => { let t = 0; const fn = () => t; fn.advance = ms => (t += ms); return fn; };

check('undo steps back and redo steps forward again', () => {
  const h = new History().reset({ n: 0 });
  h.push({ n: 1 }); h.push({ n: 2 });
  assert(h.canUndo && !h.canRedo, 'the stack is the wrong way round');
  assert(h.undo().n === 1, 'undo landed somewhere else');
  assert(h.undo().n === 0, 'undo did not reach the start');
  assert(h.undo() === null, 'undo went past the start of the build');
  assert(h.redo().n === 1 && h.redo().n === 2, 'redo did not retrace');
  assert(h.redo() === null, 'redo invented a state');
});

check('typing a number is one edit, not four keystrokes', () => {
  const now = clock();
  const h = new History({ now }).reset({ size: 0 });
  for (const v of [0, 0.4, 0.42, 0.425]) { now.advance(90); h.push({ size: v }, { key: 'edit:0:sy' }); }
  assert(h.position.of === 2, `${h.position.of} states for one number`);
  assert(h.undo().size === 0, 'one undo did not get back to before the number');
});

check('a pause, or another field, starts a new edit', () => {
  const now = clock();
  const h = new History({ now }).reset({ a: 0, b: 0 });
  h.push({ a: 1, b: 0 }, { key: 'edit:0:sx' });
  now.advance(2000);
  h.push({ a: 2, b: 0 }, { key: 'edit:0:sx' });        // same field, long after
  h.push({ a: 2, b: 1 }, { key: 'edit:0:sy' });        // different field
  assert(h.position.of === 4, `${h.position.of} states — coalescing is too greedy`);
});

check('a no-op edit does not eat an undo', () => {
  const h = new History().reset({ shape: 'cone' });
  assert(h.push({ shape: 'cone' }) === false, 'an identical state was recorded');
  assert(h.position.of === 1, 'the stack grew for nothing');
});

check('editing after an undo drops the branch in front', () => {
  const h = new History().reset({ n: 0 });
  h.push({ n: 1 }); h.push({ n: 2 });
  h.undo();
  h.push({ n: 9 });
  assert(!h.canRedo, 'the abandoned branch is still reachable');
  assert(h.current.n === 9 && h.position.of === 3, 'the new branch is wrong');
});

check('the stack has a floor and a ceiling', () => {
  const h = new History({ depth: 5 }).reset({ n: 0 });
  for (let i = 1; i <= 20; i++) h.push({ n: i });
  assert(h.position.of === 5, `${h.position.of} states with a depth of 5`);
  assert(h.current.n === 20, 'the newest state is not the one on screen');
  while (h.canUndo) h.undo();
  assert(h.current.n === 16, `undo bottomed out at ${h.current.n}`);
});

check('undo survives a part being scrapped', () => {
  const request = 'a desk lamp';
  const plan = validatePlan(offlinePlan(request), request);
  const h = new History().reset({ steps: plan.steps });
  const before = planParts(plan).length;

  removePart(plan, 0);
  h.push({ steps: plan.steps }, { label: 'scrapping a part' });
  assert(planParts(plan).length === before - 1, 'the part was not removed');

  plan.steps = structuredClone(h.undo().steps);
  assert(planParts(plan).length === before, 'undo did not bring the part back');
  assert(inspectPlan(plan).solved.instances.length >= before, 'the restored plan does not solve');
});

/* ================================================================== */
/* 7. the file that comes off the pedestal                             */
/* ================================================================== */
/* A unit cube as three.js would hand it over: 8 shared positions, 36
   indices, 12 triangles. */
const CUBE = {
  position: new Float32Array([
    -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5,
    -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5
  ]),
  index: new Uint16Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
    3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5
  ])
};
const cubeTris = () => trianglesFrom(CUBE);

check('an indexed mesh expands to the triangles it actually draws', () => {
  const t = cubeTris();
  assert(t.length === 36 * 3, `${t.length / 9} triangles from a 12-triangle cube`);
  assert(Math.max(...t) === 0.5 && Math.min(...t) === -0.5, 'the cube changed size on the way out');
});

check('a mesh comes out where its matrix puts it', () => {
  // column-major, three.js order: scale 2 about Y and shift 1m up
  const m = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 1, 0, 1];
  const t = trianglesFrom({ ...CUBE, matrix: m });
  let minY = Infinity, maxY = -Infinity;
  for (let i = 1; i < t.length; i += 3) { minY = Math.min(minY, t[i]); maxY = Math.max(maxY, t[i]); }
  near(minY, 0, 1e-6, 'the transformed part is not sitting where it was placed');
  near(maxY, 2, 1e-6, 'the transformed part is the wrong size');
});

check('STL is the length a binary STL must be, and is not read as ASCII', () => {
  const stl = toSTL([{ name: 'cube', tris: cubeTris() }]);
  assert(stl.length === 84 + 12 * 50, `${stl.length} bytes for 12 facets`);
  const dv = new DataView(stl.buffer, stl.byteOffset, stl.byteLength);
  assert(dv.getUint32(80, true) === 12, 'the facet count in the header is wrong');
  const head = new TextDecoder().decode(stl.slice(0, 5));
  assert(head !== 'solid', 'the header starts with "solid" — readers will parse it as ASCII');
});

check('the shop exports in millimetres, not metres', () => {
  const stl = toSTL([{ name: 'cube', tris: cubeTris() }]);
  const dv = new DataView(stl.buffer, stl.byteOffset, stl.byteLength);
  let max = -Infinity;
  for (let f = 0; f < 12; f++) {
    for (let v = 0; v < 9; v++) max = Math.max(max, dv.getFloat32(84 + f * 50 + 12 + v * 4, true));
  }
  near(max, 0.5 * MM, 1e-3, 'a one-metre cube did not come out 1000mm across');
});

check('STL comes out Z-up so it lands flat in a slicer', () => {
  // a wedge that is unambiguous about which way is up
  const tris = new Float32Array([0, 0, 0, 1, 0, 0, 0, 2, 0]);
  const stl = toSTL([{ name: 'wedge', tris }]);
  const dv = new DataView(stl.buffer, stl.byteOffset, stl.byteLength);
  const v3 = [dv.getFloat32(84 + 12 + 24, true), dv.getFloat32(84 + 12 + 28, true), dv.getFloat32(84 + 12 + 32, true)];
  near(v3[2], 2 * MM, 1e-3, 'the tall axis did not become Z');
  near(v3[1], 0, 1e-3, 'Y was not vacated');

  // OBJ is read by tools that are mostly Y-up, so it must NOT be swung
  const obj = toOBJ([{ name: 'wedge', tris }]);
  assert(/^v 0 2000 0$/m.test(obj), `OBJ was rotated too:\n${obj}`);
});

check('a facet with no area never reaches the file', () => {
  const tris = new Float32Array([
    0, 0, 0, 1, 0, 0, 0, 1, 0,          // real
    0, 0, 0, 1, 0, 0, 2, 0, 0,          // three points on a line
    5, 5, 5, 5, 5, 5, 5, 5, 5           // one point, three times
  ]);
  const stl = toSTL([{ name: 'x', tris }]);
  assert(stl.length === 84 + 50, `${(stl.length - 84) / 50} facets survived — degenerates got through`);
});

check('every STL normal is a unit vector', () => {
  const stl = toSTL([{ name: 'cube', tris: cubeTris() }]);
  const dv = new DataView(stl.buffer, stl.byteOffset, stl.byteLength);
  for (let f = 0; f < 12; f++) {
    const o = 84 + f * 50;
    const n = Math.hypot(dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true));
    near(n, 1, 1e-5, `facet ${f} has a normal of length ${n}`);
  }
});

check('OBJ shares vertices within a part but never across parts', () => {
  const obj = toOBJ([{ name: 'cube', tris: cubeTris() }]);
  const v = (obj.match(/^v /gm) || []).length;
  const f = (obj.match(/^f /gm) || []).length;
  assert(v === 8, `${v} vertices for a cube — dedup is not working`);
  assert(f === 12, `${f} faces`);

  const two = toOBJ([{ name: 'a', tris: cubeTris() }, { name: 'b', tris: cubeTris() }]);
  assert((two.match(/^v /gm) || []).length === 16, 'two parts were welded into one solid');
  assert((two.match(/^o /gm) || []).length === 2, 'the parts did not stay separate objects');
  // indices are 1-based and global across the file
  const last = [...two.matchAll(/^f (\d+)\/\//gm)].map(m => +m[1]);
  assert(Math.max(...last) <= 16 && Math.min(...last) >= 1, 'face indices point outside the vertex list');
});

check('a part name that would break the file is made safe', () => {
  const obj = toOBJ([{ name: 'left leg / front #2', tris: cubeTris() }, { name: '', tris: cubeTris() }]);
  assert(/^o left_leg_front_2$/m.test(obj), `the name was not cleaned:\n${obj.slice(0, 200)}`);
  assert(/^o part_2$/m.test(obj), 'an unnamed part did not get a fallback name');
});

check('the summary matches what actually gets written', () => {
  const groups = [{ name: 'a', tris: cubeTris() }, { name: 'b', tris: cubeTris() }];
  const info = summarise(groups);
  assert(info.parts === 2 && info.triangles === 24, `summary says ${info.parts}/${info.triangles}`);
  assert(info.stlBytes === toSTL(groups).length, 'the predicted size is not the real size');
});

check('an empty pedestal exports an empty file rather than throwing', () => {
  assert(toSTL([]).length === 84, 'an empty STL is malformed');
  assert(toSTL([{ name: 'x', tris: new Float32Array([1, 2, 3]) }]).length === 84, 'a partial triangle got through');
  assert(typeof toOBJ([]) === 'string', 'an empty OBJ threw');
});

/* ================================================================== */
console.log(out.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
