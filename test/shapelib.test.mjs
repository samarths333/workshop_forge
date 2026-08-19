/* =====================================================================
   The shape vocabulary.

   The nine primitives were nine arms of a switch, and the whole risk of
   turning them into data is that a shape nobody wrote code for is a shape
   nobody checked. So this file checks the things that would otherwise be
   checked by somebody looking at it:

   · a definition off disk is untrusted, exactly like a plan off a model,
     and the ways it can be broken are all boring — a NaN, a profile with
     no height, a name that collides with a built-in, a hole with two
     points in it. Every one of them draws SOMETHING and none of them throw.
   · the registry is live. A shape saved at four o'clock has to be in the
     planner's enum at four-oh-one, and the enum is one array mutated in
     place so that everything holding a reference to it stays right.
   · the invariant that makes the whole design safe — a defined shape
     measures exactly the size it was asked for — is checked here on the
     arithmetic and in geometry.test.mjs on real meshes.
   ===================================================================== */

import {
  BUILTIN_SHAPES, SHAPE_KINDS, SHAPE_ENUM, PRIMITIVE_SHAPES,
  validateShapeDef, sanitizeLibrary, registerShapes, customShapes, allShapes,
  shapeDef, isShape, shapeIds, newShapeFrom, upsertShape, removeShape,
  revolvePoints, outlinePoints, holePoints, shapeBlock, searchShapes
} from '../renderer/shapelib.js';
import { SHAPES } from '../renderer/assembly.js';
import { validatePlan, planParts } from '../renderer/agent.js';

let pass = 0, fail = 0;
const out = [];
const check = (name, fn) => {
  try { fn(); pass++; out.push(`  ok    ${name}`); }
  catch (e) { fail++; out.push(`  FAIL  ${name}\n          ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const near = (a, b, tol, m) => assert(Math.abs(a - b) <= tol, `${m} (${a} vs ${b})`);

const reset = () => registerShapes([]);

/* ------------------------------------------------------------------ */
/* the built-in library                                                */
/* ------------------------------------------------------------------ */
check('every shape the shop ships is a shape the shop can build', () => {
  reset();
  assert(BUILTIN_SHAPES.length >= 20, `only ${BUILTIN_SHAPES.length} shapes beyond the primitives`);
  const seen = new Set();
  for (const s of BUILTIN_SHAPES) {
    assert(SHAPE_KINDS.includes(s.kind), `${s.id} is swept by "${s.kind}", which is not a way to sweep something`);
    assert(!seen.has(s.id), `two shapes are called "${s.id}"`);
    seen.add(s.id);
    assert(validateShapeDef(s, { custom: false }), `${s.id} does not survive its own validator`);
    assert(s.words?.length, `${s.id} has no words anybody would search for`);
    const pts = s.kind === 'revolve' ? s.profile : s.outline;
    assert(pts.length >= 3, `${s.id} has ${pts.length} points`);
  }
});

/* An id that collides with one of the aliases in partGeometry — `tube`,
   `plate`, `bar`, `ball`, `ring` — is silently never reached: the switch
   catches it first and draws the old shape. It looks exactly like a
   profile that came out wrong, which is why it is a test. */
check('no shape is named after something partGeometry already answers to', () => {
  const taken = ['box', 'panel', 'plate', 'cylinder', 'tube', 'rod', 'bar',
    'cone', 'sphere', 'ball', 'torus', 'ring', 'wedge', 'gear'];
  for (const s of BUILTIN_SHAPES) {
    assert(!taken.includes(s.id), `"${s.id}" is already an alias for a primitive — it would never be drawn`);
  }
});

check('the two lists of primitives are the same list', () => {
  assert(PRIMITIVE_SHAPES.join(',') === SHAPES.join(','),
    `shapelib knows ${PRIMITIVE_SHAPES.join(',')} but the solver knows ${SHAPES.join(',')}`);
});

/* ------------------------------------------------------------------ */
/* what comes off disk                                                 */
/* ------------------------------------------------------------------ */
check('a definition that would draw nothing is refused', () => {
  const base = { id: 'thing', kind: 'extrude', outline: [[0, 0], [1, 0], [1, 1], [0, 1]] };
  assert(validateShapeDef(base), 'a perfectly good square was refused');

  const bad = [
    [{ ...base, outline: [[0, 0], [1, 0]] }, 'two points is a line'],
    [{ ...base, outline: [[0, 0], [1, 0], [2, 0]] }, 'an outline with no area'],
    [{ ...base, outline: [[0, 0], [0, 1], [0, 2]] }, 'an outline with no width'],
    [{ ...base, id: '' }, 'no name at all'],
    [{ ...base, id: '9lives' }, 'a name starting with a digit'],
    [{ id: 'spun', kind: 'revolve', profile: [[0, 0], [0, 0.5], [0, 1]] }, 'a revolve with no radius'],
    [{ id: 'spun', kind: 'revolve', profile: [[1, 0.5], [0.5, 0.5], [0.2, 0.5]] }, 'a revolve with no height'],
    [null, 'nothing at all'],
    ['a cone please', 'a string']
  ];
  for (const [def, why] of bad) {
    assert(validateShapeDef(def) === null, `${why} was accepted`);
  }

  /* A NaN is NOT in that list on purpose. The rule here is the one
     validatePlan follows — drop what is unusable and keep what is left —
     so a profile with one bad point comes back with the other points,
     which is checked below. It only fails if what is left draws nothing. */
  assert(validateShapeDef({ ...base, outline: [[0, 0], [NaN, 1], [1, 1], [0, 1]] }),
    'one bad point threw away a shape that was otherwise fine');
});

check('a NaN in a profile never reaches the geometry', () => {
  const d = validateShapeDef({
    id: 'messy', kind: 'revolve',
    profile: [[0, 0], [Infinity, 0.2], [1, 0.5], ['x', 0.7], [0, 1]]
  });
  assert(d, 'every point was thrown away, not just the bad ones');
  for (const [r, y] of d.profile) {
    assert(Number.isFinite(r) && Number.isFinite(y), 'a non-finite point survived');
  }
});

check('the library file is sanitized whole, and one bad shape costs only itself', () => {
  const list = sanitizeLibrary([
    { id: 'good_one', kind: 'extrude', outline: [[0, 0], [1, 0], [1, 1]] },
    { id: 'bad_one', kind: 'extrude', outline: [[0, 0]] },
    { id: 'good_two', kind: 'revolve', profile: [[0, 0], [1, 0], [1, 1], [0, 1]] },
    'nonsense',
    { id: 'cone', kind: 'revolve', profile: [[0, 0], [1, 0], [0, 1]] }        // shadows a primitive
  ]);
  const ids = list.map(s => s.id);
  assert(ids.includes('good_one') && ids.includes('good_two'), `the good ones were lost: ${ids}`);
  assert(!ids.includes('bad_one'), 'a shape that draws nothing was kept');
  assert(list.every(s => s.custom), 'a shape off disk is not marked as the user’s');
  assert(sanitizeLibrary(null).length === 0, 'a missing file threw instead of being empty');
});

/* A saved shape must never shadow a built-in, or a plan that says `cone`
   means one thing on this machine and another on the next one. */
check('a shape of your own cannot take a name the shop already ships', () => {
  reset();
  for (const id of ['cone', 'box', 'dome', 'ibeam']) {
    const r = upsertShape([], { id, kind: 'revolve', profile: [[0, 0], [1, 0], [0, 1]] });
    assert(!r.ok, `"${id}" was allowed to shadow a shape the shop ships`);
    assert(/already ships/.test(r.error), `the refusal for "${id}" does not say why: ${r.error}`);
  }
  const fine = upsertShape([], { id: 'my_cone', kind: 'revolve', profile: [[0, 0], [1, 0], [0, 1]] });
  assert(fine.ok && fine.list.length === 1, 'a properly named shape was refused');
});

/* ------------------------------------------------------------------ */
/* the registry                                                        */
/* ------------------------------------------------------------------ */
/* The enum is handed to the model inside a schema that is built once at
   module load. If registering a shape swapped the array for a new one,
   every schema built before that moment would keep the old vocabulary and
   the shape would be unusable until a restart — with nothing to see. */
check('the planner’s vocabulary is one array, and it stays current', () => {
  reset();
  const held = SHAPE_ENUM;                       // as a schema would hold it
  const before = held.length;
  registerShapes([{ id: 'my_scoop', kind: 'revolve', profile: [[0, 0], [1, 0.2], [0.8, 1], [0, 1]] }]);
  assert(held === SHAPE_ENUM, 'the enum was replaced rather than updated');
  assert(held.includes('my_scoop'), 'a saved shape never reached the enum a schema is holding');
  assert(held.length === before + 1, `the enum went from ${before} to ${held.length}`);

  registerShapes([]);
  assert(!held.includes('my_scoop'), 'a deleted shape stayed in the vocabulary');
  assert(held.length === before, 'the enum did not come back to where it started');
});

check('the vocabulary is the primitives, the shipped shapes, and yours', () => {
  reset();
  registerShapes([{ id: 'my_tray', kind: 'extrude', outline: [[0, 0], [1, 0], [1, 1], [0, 1]] }]);
  const ids = shapeIds();
  for (const p of PRIMITIVE_SHAPES) assert(ids.includes(p), `${p} is missing from the vocabulary`);
  for (const b of BUILTIN_SHAPES) assert(ids.includes(b.id), `${b.id} is missing from the vocabulary`);
  assert(ids.includes('my_tray'), 'a saved shape is missing from the vocabulary');
  assert(new Set(ids).size === ids.length, 'the vocabulary has a duplicate in it');

  assert(isShape('dome') && isShape('my_tray') && isShape('box'), 'isShape does not know a real shape');
  assert(!isShape('banana') && !isShape('') && !isShape(null), 'isShape accepted something that is not a shape');

  assert(customShapes().length === 1, 'the user’s own shapes are not separable from the shipped ones');
  assert(allShapes().length === ids.length, 'allShapes and the enum disagree');
  assert(shapeDef('my_tray')?.custom === true, 'a saved shape is not marked as the user’s');
  assert(shapeDef('box') === null, 'a primitive has a profile, when it is drawn by hand');
});

/* ------------------------------------------------------------------ */
/* the invariant                                                       */
/* ------------------------------------------------------------------ */
/* Every defined shape is normalised into the box it was asked for. That is
   what lets assembly.js stay ignorant of all of them: effectiveSize hands
   back the size it was given, and it is right. Here on the numbers;
   geometry.test.mjs does it again on real meshes. */
check('a profile is normalised into the size it was asked for', () => {
  const def = shapeDef('vase');
  for (const size of [[0.5, 0.5, 0.5], [1.2, 0.3, 0.4], [0.1, 2.0, 0.1]]) {
    const pts = revolvePoints(def, size);
    const rMax = Math.max(...pts.map(p => p[0]));
    const yLo = Math.min(...pts.map(p => p[1])), yHi = Math.max(...pts.map(p => p[1]));
    near(rMax * 2, size[0], 1e-6, 'the widest point is not the width it was asked for');
    near(yHi - yLo, size[1], 1e-6, 'the profile is not the height it was asked for');
    near(yHi + yLo, 0, 1e-6, 'the profile is not centred on its own origin');
  }
});

check('an outline is normalised the same way, and its holes come with it', () => {
  const def = shapeDef('ring_plate');
  const size = [0.8, 0.6, 0.2];
  const box = outlinePoints(def.outline, size);
  const xs = box.pts.map(p => p[0]), ys = box.pts.map(p => p[1]);
  near(Math.max(...xs) - Math.min(...xs), size[0], 1e-6, 'the outline is not the width asked for');
  near(Math.max(...ys) - Math.min(...ys), size[1], 1e-6, 'the outline is not the height asked for');

  /* The hole is measured against the OUTLINE's box. Normalising it against
     its own would blow a 40% bore up to fill the whole plate — and it
     would look deliberate. */
  const hole = holePoints(def.holes[0], box, size);
  const hx = hole.map(p => p[0]);
  const across = Math.max(...hx) - Math.min(...hx);
  assert(across < size[0] * 0.75, `the bore came out ${across.toFixed(3)} across a ${size[0]} plate`);
  assert(across > size[0] * 0.15, `the bore came out ${across.toFixed(3)}, which is not a bore`);
});

/* ------------------------------------------------------------------ */
/* making one                                                          */
/* ------------------------------------------------------------------ */
/* Nobody authors a profile from an empty list, so a new shape is always a
   copy of one that already works — including a copy of a PRIMITIVE, which
   has no stored profile and needs a plausible one made up for it. */
check('a new shape can start from anything, including the hand-drawn nine', () => {
  reset();
  for (const from of [...PRIMITIVE_SHAPES, ...BUILTIN_SHAPES.map(s => s.id)]) {
    const d = newShapeFrom(from, 'my_thing', 'My thing');
    assert(d, `nothing to start from when copying "${from}"`);
    assert(d.id === 'my_thing' && d.custom, `the copy of "${from}" kept the wrong identity`);
    const pts = d.kind === 'revolve' ? d.profile : d.outline;
    assert(pts?.length >= 3, `the copy of "${from}" came out with no profile`);
  }
  assert(newShapeFrom('banana', 'x', 'X') === null, 'copying a shape that does not exist gave something back');
});

check('a copy is a copy — editing one does not edit the shape it came from', () => {
  const d = newShapeFrom('dome', 'my_dome', 'My dome');
  d.profile[0][0] = 0.123;
  assert(shapeDef('dome').profile[0][0] !== 0.123, 'the built-in was edited through its copy');
});

check('saving replaces rather than duplicates, and deleting takes it away', () => {
  let list = [];
  list = upsertShape(list, newShapeFrom('cone', 'my_horn', 'Horn')).list;
  list = upsertShape(list, newShapeFrom('bowl', 'my_horn', 'Horn again')).list;
  assert(list.length === 1, `saving the same name twice made ${list.length} shapes`);
  assert(list[0].kind === 'revolve', 'the newer definition did not win');

  list = upsertShape(list, newShapeFrom('hex', 'my_plate', 'Plate')).list;
  assert(list.length === 2, 'a second, differently named shape did not save');

  const gone = removeShape(list, 'my_horn');
  assert(gone.ok && gone.list.length === 1, 'deleting did not take one away');
  assert(!removeShape(gone.list, 'my_horn').ok, 'deleting something twice reported success');
});

/* ------------------------------------------------------------------ */
/* through the rest of the shop                                        */
/* ------------------------------------------------------------------ */
/* The point of all of it. A saved shape has to survive the validator that
   every plan goes through, or it is a shape you can draw and not build. */
check('a plan may use a shape somebody made, and one nobody made is coerced', () => {
  reset();
  registerShapes([{ id: 'my_scoop', kind: 'revolve', profile: [[0, 0], [1, 0.2], [0.8, 1], [0, 1]] }]);

  const plan = validatePlan({
    title: 'a thing', summary: 'test',
    steps: [
      { room: 'metal', action: 'weld', say: 'making it', seconds: 4,
        part: { name: 'scoop', shape: 'my_scoop', material: 'metal', size: [0.4, 0.3, 0.4] } },
      { room: 'metal', action: 'weld', say: 'and this', seconds: 4,
        part: { name: 'mystery', shape: 'wobblething', material: 'metal', size: [0.4, 0.3, 0.4] } },
      { room: 'finished', action: 'present', say: 'done', seconds: 3 }
    ]
  }, 'a thing');

  const parts = planParts(plan);
  assert(parts[0].shape === 'my_scoop', `a saved shape was coerced to "${parts[0].shape}"`);
  assert(parts[1].shape === 'box', `a shape that does not exist survived as "${parts[1].shape}"`);

  /* and when the shape is deleted, a plan that used it still validates —
     as a box, which is the same rule every other unknown value follows */
  reset();
  const after = validatePlan(plan, 'a thing');
  assert(planParts(after)[0].shape === 'box', 'a plan using a deleted shape did not fall back');
});

check('the planner is told what it may reach for, including the shop’s own', () => {
  reset();
  const plain = shapeBlock();
  for (const id of ['dome', 'channel', 'ibeam', 'nosecone']) {
    assert(plain.includes(id), `the prompt never mentions "${id}"`);
  }
  assert(!/the shop's own/.test(plain), 'the prompt talks about custom shapes when there are none');

  registerShapes([{ id: 'my_scoop', kind: 'revolve', note: 'a scoop', profile: [[0, 0], [1, 0.2], [0.8, 1], [0, 1]] }]);
  const mine = shapeBlock();
  assert(/the shop's own/.test(mine) && mine.includes('my_scoop'), 'a saved shape is never offered to the planner');
  reset();
});

/* Three letters is what anybody actually types. Same standard the command
   palette is held to. */
check('the picker finds a shape by its start, its middle, and what it is for', () => {
  reset();
  const first = q => searchShapes(q)[0]?.id;
  assert(first('chan') === 'channel', `"chan" found ${first('chan')}`);
  assert(first('ibeam') === 'ibeam', `"ibeam" found ${first('ibeam')}`);
  assert(searchShapes('pipe').some(s => s.id === 'pipe'), '"pipe" does not find the pipe');
  assert(searchShapes('tube').some(s => s.id === 'pipe'), '"tube" does not find the pipe it was renamed from');
  assert(searchShapes('girder').some(s => s.id === 'ibeam'), 'a girder is not an I-beam');
  assert(searchShapes('hemisphere').some(s => s.id === 'dome'), 'a hemisphere is not a dome');
  assert(searchShapes('zzzz').length === 0, 'searching for nonsense found something');
  assert(searchShapes('').length === allShapes().length, 'an empty search does not list everything');
});

console.log(out.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
