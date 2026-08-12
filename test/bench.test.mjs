/* The bench's own arithmetic, and the routing that decides where Rivet
   goes looking.

   Both are pure string and number work, and both are the kind of thing
   that fails silently: a density in the wrong units gives a lamp that
   weighs four tonnes and nothing throws, and a classifier that sends a
   turbofan to a print site just quietly returns keychains.

     node test/bench.test.mjs
*/
import {
  volumeOf, areaOf, partMetrics, assemblyMetrics, measureBetween,
  bom, bomCSV, formatLen, parseLen, formatMass, toUnit, fromUnit, DENSITY
} from '../renderer/metrics.js';
import {
  classifyRequest, sourcesFor, searchTerms, structureFrom,
  technicalBlock, mergeRefs, enrichRefs, domainKnowledge, SOURCES
} from '../renderer/library.js';
import { solveAssembly } from '../renderer/assembly.js';
import { engineeringBlock, buildMessages } from '../renderer/agent.js';

let pass = 0, fail = 0;
const out = [];
const check = (name, fn) => {
  try { fn(); pass++; out.push(`  ok    ${name}`); }
  catch (e) { fail++; out.push(`  FAIL  ${name}\n          ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const near = (a, b, tol, m) => assert(Math.abs(a - b) <= tol, `${m} (${a} vs ${b})`);

/* ================================================================== */
/* volume and mass                                                     */
/* ================================================================== */
check('a cubic metre of steel weighs what a cubic metre of steel weighs', () => {
  const v = volumeOf('box', [1, 1, 1]);
  near(v, 1, 1e-9, 'a 1m cube is not 1m³');
  const m = partMetrics({ shape: 'box', size: [1, 1, 1], material: 'metal' });
  near(m.mass, DENSITY.metal, 1, 'a cubic metre of steel came out wrong');
});

check('the round shapes are round, not the boxes they fit in', () => {
  // a cylinder is π/4 of its bounding box
  near(volumeOf('cylinder', [1, 1, 1]) / volumeOf('box', [1, 1, 1]), Math.PI / 4, 1e-6, 'cylinder');
  // a cone is a third of its cylinder
  near(volumeOf('cone', [1, 1, 1]) / volumeOf('cylinder', [1, 1, 1]), 1 / 3, 1e-6, 'cone');
  // a sphere is π/6 of its box
  near(volumeOf('sphere', [1, 1, 1]) / volumeOf('box', [1, 1, 1]), Math.PI / 6, 1e-6, 'sphere');
});

check('volume follows the size the solver actually uses', () => {
  // a rod is drawn a third of its stated width — the volume has to agree,
  // or the bench reports nine times the mass of the part on screen
  const rod = volumeOf('rod', [0.3, 1, 0.3]);
  const asDrawn = Math.PI * (0.05 ** 2) * 1;
  near(rod, asDrawn, 1e-9, 'a rod is being weighed as its bounding box');
});

check('a slab of cardboard does not weigh the same as a slab of steel', () => {
  const size = [0.4, 0.4, 0.4];
  const steel = partMetrics({ shape: 'box', size, material: 'metal' }).mass;
  const card = partMetrics({ shape: 'box', size, material: 'cardboard' }).mass;
  assert(steel > card * 20, `steel ${steel} vs cardboard ${card} — the densities are not being applied`);
});

check('scaling the build to fit scales what it weighs', () => {
  const full = partMetrics({ shape: 'box', size: [1, 1, 1], material: 'metal', scale: 1 }).mass;
  const half = partMetrics({ shape: 'box', size: [1, 1, 1], material: 'metal', scale: 0.5 }).mass;
  near(half, full / 8, 1, 'mass did not follow the cube of the fit scale');
});

check('every shape has a positive volume and area at every size', () => {
  for (const s of ['box', 'panel', 'cylinder', 'rod', 'cone', 'sphere', 'torus', 'wedge', 'gear', 'tube']) {
    for (const size of [[0.2, 0.2, 0.2], [1.2, 0.08, 0.9], [0.44, 1.5, 0.44]]) {
      const v = volumeOf(s, size), a = areaOf(s, size);
      assert(v > 0 && Number.isFinite(v), `${s} at ${size} has volume ${v}`);
      assert(a > 0 && Number.isFinite(a), `${s} at ${size} has area ${a}`);
      assert(v < 4, `${s} at ${size} came out at ${v}m³ — bigger than the shop`);
    }
  }
});

/* ================================================================== */
/* the whole assembly                                                  */
/* ================================================================== */
const LAMP = [
  { name: 'base', shape: 'cylinder', material: 'metal', size: [0.5, 0.12, 0.5] },
  { name: 'stem', shape: 'rod', material: 'metal', size: [0.14, 0.8, 0.14], attach: { to: 0, face: 'top' } },
  { name: 'shade', shape: 'cone', material: 'painted', size: [0.44, 0.32, 0.44], attach: { to: 1, face: 'top' } }
];

check('the assembly weighs the sum of its parts', () => {
  const solved = solveAssembly(LAMP);
  const m = assemblyMetrics(solved);
  const byHand = solved.instances.reduce((n, i) => n + partMetrics(i).mass, 0);
  near(m.mass, byHand, 1e-9, 'the total is not the sum');
  assert(m.parts === solved.instances.length, 'parts miscounted');
  assert(m.byMaterial.length >= 1 && m.byMaterial[0].mass >= m.byMaterial.at(-1).mass,
    'the material breakdown is not sorted by mass');
});

check('the centre of mass of a lamp is low, because the base is the heavy bit', () => {
  const solved = solveAssembly(LAMP);
  const m = assemblyMetrics(solved);
  assert(m.com[1] > 0, 'the centre of mass is underground');
  assert(m.com[1] < m.size[1] * 0.5, `centre of mass at ${m.com[1].toFixed(2)}m of ${m.size[1].toFixed(2)}m — a lamp is bottom-heavy`);
  assert(m.stable, 'a lamp on its own base was called unstable');
});

check('something that would topple is called out', () => {
  /* A heavy slab held out to one side on a small foot. The deliberate dy
     is what keeps it there: a nudge up the Y axis pins a part, so gravity
     does not quietly drop it to the floor and make it part of the base —
     which is exactly the case where the solver is happy and the object
     still falls over the moment it is real. */
  const solved = solveAssembly([
    { name: 'foot', shape: 'box', material: 'metal', size: [0.2, 0.15, 0.2] },
    { name: 'slab', shape: 'box', material: 'metal', size: [1.6, 0.4, 0.5], attach: { to: 0, face: 'top', dx: 1.1, dy: 0.4 } }
  ]);
  const m = assemblyMetrics(solved);
  assert(!m.stable, `tipRatio ${m.tipRatio.toFixed(2)} — a slab held a metre off a 200mm foot was called stable`);
  assert(m.tipRatio > 2, `tipRatio only ${m.tipRatio.toFixed(2)}`);

  // and the ordinary case is not called a topple just because it is tall
  const tall = assemblyMetrics(solveAssembly([
    { name: 'base', shape: 'cylinder', material: 'metal', size: [0.6, 0.1, 0.6] },
    { name: 'mast', shape: 'rod', material: 'metal', size: [0.12, 1.4, 0.12], attach: { to: 0, face: 'top' } }
  ]));
  assert(tall.stable, 'a mast on a wide base was called unstable');
});

check('an empty bench reports nothing rather than NaN', () => {
  const m = assemblyMetrics(null);
  assert(m.parts === 0 && m.mass === 0 && m.stable, 'an empty assembly is not empty');
  assert(m.com.every(Number.isFinite), 'the centre of mass of nothing is not a number');
});

/* ================================================================== */
/* measuring                                                           */
/* ================================================================== */
check('clearance is the air between two parts, not their centres', () => {
  const a = { pos: [0, 0, 0], half: [0.1, 0.1, 0.1] };
  const b = { pos: [0.5, 0, 0], half: [0.1, 0.1, 0.1] };
  const r = measureBetween(a, b);
  near(r.centre, 0.5, 1e-9, 'centre to centre');
  near(r.gap, 0.3, 1e-9, 'clearance');
  assert(r.axisName === 'X', `separated on ${r.axisName}`);
  assert(!r.interfering && !r.touching, 'two parts 300mm apart are not touching');
});

check('parts driven into each other read as interfering', () => {
  const a = { pos: [0, 0, 0], half: [0.2, 0.2, 0.2] };
  const b = { pos: [0.1, 0, 0], half: [0.2, 0.2, 0.2] };
  const r = measureBetween(a, b);
  assert(r.interfering && r.gap < 0, `gap ${r.gap} — an overlap was not reported`);
});

check('parts that just touch say so', () => {
  const a = { pos: [0, 0, 0], half: [0.1, 0.1, 0.1] };
  const b = { pos: [0, 0.2, 0], half: [0.1, 0.1, 0.1] };
  assert(measureBetween(a, b).touching, 'a part sitting exactly on another was not called touching');
  assert(measureBetween(a, null) === null, 'measuring against nothing did not return null');
});

/* ================================================================== */
/* units                                                               */
/* ================================================================== */
check('the panel talks millimetres and the spec keeps metres', () => {
  near(toUnit(0.42, 'mm'), 420, 1e-9, 'metres to mm');
  near(fromUnit(420, 'mm'), 0.42, 1e-12, 'mm to metres');
  assert(formatLen(0.42, 'mm') === '420 mm', formatLen(0.42, 'mm'));
  assert(formatLen(0.42, 'cm') === '42 cm', formatLen(0.42, 'cm'));
  assert(formatLen(0.42, 'm') === '0.42 m', formatLen(0.42, 'm'));
});

check('a typed unit beats the panel it was typed into', () => {
  near(parseLen('420', 'mm'), 0.42, 1e-12, 'a bare number takes the panel unit');
  near(parseLen('42cm', 'mm'), 0.42, 1e-12, 'an explicit cm was ignored');
  near(parseLen('0.42 m', 'mm'), 0.42, 1e-12, 'an explicit m was ignored');
  assert(parseLen('', 'mm') === null && parseLen('wide', 'mm') === null, 'nonsense parsed as a number');
});

check('mass is written the way a person would say it', () => {
  assert(formatMass(0.0004) === '400 mg', formatMass(0.0004));
  assert(formatMass(0.25) === '250 g', formatMass(0.25));
  assert(formatMass(12.4) === '12.4 kg', formatMass(12.4));
});

/* ================================================================== */
/* the parts list                                                      */
/* ================================================================== */
check('the parts list counts an array as a quantity, not as parts', () => {
  const parts = [
    { name: 'top', shape: 'panel', material: 'wood', size: [1.2, 0.08, 0.9] },
    { name: 'leg', shape: 'rod', material: 'metal', size: [0.12, 0.68, 0.12], attach: { to: 0, face: 'bottom' }, array: { mode: 'quad', radius: 0.44, count: 4 } }
  ];
  const rows = bom(solveAssembly(parts), parts);
  assert(rows.length === 2, `${rows.length} lines for a table — the legs should be one line`);
  const leg = rows.find(r => r.name === 'leg');
  assert(leg.qty === 4, `${leg.qty} legs`);
  assert(leg.mass > 0 && leg.size.length === 3, 'the leg line has no numbers on it');
});

check('the CSV is a CSV, in the unit that was asked for', () => {
  const parts = [{ name: 'a, tricky "name"', shape: 'box', material: 'metal', size: [0.5, 0.5, 0.5] }];
  const csv = bomCSV(bom(solveAssembly(parts), parts), { unit: 'mm' });
  const lines = csv.split('\n');
  assert(lines.length === 2, `${lines.length} lines`);
  assert(lines[0].includes('width (mm)'), 'the header does not say what unit it is in');
  assert(lines[1].includes('"a, tricky ""name"""'), `the quoting is wrong:\n${lines[1]}`);
  assert(/,500,/.test(lines[1]), `500mm did not come out as 500:\n${lines[1]}`);
});

/* ================================================================== */
/* where to go looking                                                 */
/* ================================================================== */
check('an engine is not sent to a print site', () => {
  for (const ask of ['a turbofan engine', 'a v8 engine block', 'a rocket engine with a nozzle', 'a turbine stage']) {
    const d = classifyRequest(ask);
    assert(d.engineering, `"${ask}" was treated as a maker project`);
    assert(d.domain === 'propulsion', `"${ask}" classified as ${d.domain}`);
    const s = sourcesFor(d.domain);
    assert(s[0] === 'wikipedia', `"${ask}" goes to ${s[0]} first`);
    assert(s.includes('ntrs'), 'anything that burns fuel should be asking NASA');
  }
});

check('a wing goes to the aerospace sources, a phone stand does not', () => {
  const wing = classifyRequest('a glider wing with ailerons');
  assert(wing.domain === 'aerospace', `wing classified as ${wing.domain}`);

  const stand = classifyRequest('a phone stand with a cable slot');
  assert(!stand.engineering, 'a phone stand was sent to an encyclopedia');
  assert(sourcesFor(stand.domain).join() === 'thingiverse,printables', 'the maker route changed');
});

check('the specific reading wins over the general one', () => {
  // "rocket engine" is propulsion, not a rocket; "landing gear" is
  // airframe, not a mechanism
  assert(classifyRequest('a rocket engine').domain === 'propulsion', 'rocket engine misrouted');
  assert(classifyRequest('landing gear for a light aircraft').domain === 'aerospace', 'landing gear misrouted');
  assert(classifyRequest('a differential for a rear axle').domain === 'mechanism', 'differential misrouted');
});

check('an encyclopedia is asked for the noun, not the sentence', () => {
  const t = searchTerms('build me a working turbofan engine with visible fan blades', 'propulsion');
  assert(t.length >= 2, `only ${t.length} search terms`);
  assert(!/\b(build|me|with)\b/.test(t[0]), `the noise is still in there: "${t[0]}"`);
  assert(t.some(x => x.split(' ').length <= 3), 'no short form was offered');
});

/* ================================================================== */
/* reading structure out of prose                                      */
/* ================================================================== */
check('a parts list is mined out of an encyclopedia paragraph', () => {
  const text = 'A turbofan consists of a fan, a low-pressure compressor, a combustor, '
    + 'a high-pressure turbine and a nozzle. It was developed in the 1940s.';
  const s = structureFrom(text);
  assert(s.includes('fan'), `no fan in ${JSON.stringify(s)}`);
  assert(s.includes('combustor'), `no combustor in ${JSON.stringify(s)}`);
  assert(s.includes('low-pressure compressor'), `hyphenated names are being dropped: ${JSON.stringify(s)}`);
  assert(!s.some(x => /develop|1940/.test(x)), `prose leaked into the parts list: ${JSON.stringify(s)}`);
});

check('prose that is not a parts list yields nothing rather than nonsense', () => {
  const s = structureFrom('The engine was widely regarded as reliable and was used until 1987.');
  assert(s.length === 0, `invented parts: ${JSON.stringify(s)}`);
  assert(structureFrom('').length === 0 && structureFrom(null).length === 0, 'empty input threw or invented');
});

check('a clause is not mistaken for a part name', () => {
  const s = structureFrom('It consists of a shaft which is supported by bearings that are usually greased, and a housing.');
  assert(s.includes('housing'), `the real part was lost: ${JSON.stringify(s)}`);
  assert(!s.some(x => x.split(' ').length > 3), `a clause got through: ${JSON.stringify(s)}`);
});

/* ================================================================== */
/* what the planner is told                                            */
/* ================================================================== */
check('an engineering request carries a vocabulary even with nothing found', () => {
  const block = engineeringBlock('a turbofan engine', []);
  assert(block.includes('combustor'), 'the built-in propulsion vocabulary is missing');
  assert(block.includes('compressor'), 'no compressor in the engine prompt');
  assert(block.length > 300, 'the block is too thin to be useful');
});

check('a maker request gets no engineering block at all', () => {
  assert(engineeringBlock('a desk lamp with a folding arm', []) === '', 'a lamp got an engineering lecture');
});

check('what was found is folded in beside what the shop already knew', () => {
  const refs = enrichRefs([{
    source: 'wikipedia', title: 'Turbofan',
    summary: 'A turbofan comprises a fan, a compressor, a combustor and a turbine. '.repeat(8)
  }]);
  assert(refs[0].structure.includes('fan'), 'the structure was not mined on the way in');
  assert(refs[0].summary.length < 400, `the extract was not trimmed: ${refs[0].summary.length} chars`);

  const block = technicalBlock('a turbofan', refs, 'propulsion');
  assert(block.includes('Turbofan'), 'the source was not cited');
  assert(block.includes('parts named:'), 'the mined parts were not shown');
});

check('the maker block and the engineering block do not describe each other', () => {
  const refs = [
    { source: 'wikipedia', title: 'Turbofan', summary: 'It consists of a fan and a turbine.' },
    { source: 'thingiverse', title: 'Jet Engine Keychain', tags: ['keychain'], summary: '' }
  ];
  const msgs = buildMessages('a turbofan engine', null, enrichRefs(refs));
  const sys = msgs[0].content;
  const maker = sys.slice(sys.indexOf('HOW PEOPLE ACTUALLY MAKE THIS'), sys.indexOf('WHAT THE REAL THING IS MADE OF'));
  assert(maker.includes('Keychain'), 'the print was dropped from the maker block');
  assert(!maker.includes('Turbofan  '), 'an encyclopedia article is being sold as a published design');
  assert(sys.includes('WHAT THE REAL THING IS MADE OF'), 'the engineering block never made it into the prompt');
});

check('two sources returning the same thing take one slot', () => {
  const merged = mergeRefs([
    [{ source: 'wikipedia', title: 'Turbofan' }, { source: 'commons', title: 'Turbofan' }],
    [{ source: 'ntrs', title: 'Turbofan compressor dynamics' }, null, { title: '' }]
  ]);
  assert(merged.length === 2, `${merged.length} refs after dedupe`);
  assert(merged[0].source === 'wikipedia', 'the first source lost its place');
});

check('every source the router can name is one that exists', () => {
  for (const d of ['making', 'propulsion', 'aerospace', 'mechanism', 'structure', 'vehicle', 'robotics']) {
    for (const s of sourcesFor(d)) {
      assert(SOURCES[s], `${d} routes to "${s}", which is not a source`);
    }
    if (d !== 'making') assert(domainKnowledge(d), `${d} has no built-in vocabulary`);
  }
});

/* ================================================================== */
console.log(out.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
