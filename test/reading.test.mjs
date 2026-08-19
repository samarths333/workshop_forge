/* Reading the open web.

   The complaint this answers: most of what people ask for is not on a
   print site, and a model asked for it from memory invents a plausible
   slab. The fix is not more search results — it is opening the page
   behind the result and taking out the two things a title cannot carry:
   the part names people actually use, and the sizes they actually quote.

   All of that is string work, so all of it is checked here with no
   network in the loop. The fixtures below are written the way real pages
   read, navigation and comments included, because the job is as much
   about ignoring the rubbish as finding the good bit.

     node test/reading.test.mjs
*/
import {
  sourcesFor, worthReading, minePages, pageValue, dimensionsFrom,
  readingBlock, structureFrom, SOURCES, classifyRequest
} from '../renderer/library.js';
import { buildMessages, buildCritiqueMessages } from '../renderer/agent.js';

let pass = 0, fail = 0;
const out = [];
const check = (name, fn) => {
  try { fn(); pass++; out.push(`  ok    ${name}`); }
  catch (e) { fail++; out.push(`  FAIL  ${name}\n          ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

/* A build thread, as one actually reads. */
const THREAD = `
Home Forums Shop Search Log in Register
Bandsaw fence build — 47 replies
Skip to content
I finally got round to this. The fence consists of an aluminium extrusion,
a hardwood face, a cam clamp at each end and a small alignment block.
I used 3/4 inch maple for the face because that is what was in the offcut
bin, and the extrusion is 600mm long. The face ends up 100mm tall.
Drill the extrusion for M6 bolts before you glue anything.
Reply Quote Report
Nice work! Following this thread.
Posted 4 years ago · 12 likes · Share on Facebook
Cookie preferences Accept all Manage settings
`;

/* And a page that is not about making anything. */
const NEWS = `
Breaking: local council approves new bandsaw regulations after lengthy
consultation. The measure was welcomed by industry groups and criticised
by others. Subscribe for more. Related articles. Sign up to our newsletter.
Comments are closed. Copyright 2019 all rights reserved.
`;

/* ================================================================== */
/* is this page worth anything                                         */
/* ================================================================== */
check('a build thread scores, a news page does not', () => {
  const good = pageValue(THREAD), bad = pageValue(NEWS);
  assert(good > bad * 2, `build thread ${good.toFixed(1)} vs news ${bad.toFixed(1)} — they should not be close`);
  assert(good > 1.2, `a page full of instructions scored only ${good.toFixed(1)}`);
  assert(pageValue('') === 0 && pageValue(null) === 0, 'nothing should score nothing');
  assert(pageValue('too short to judge') === 0, 'a stub should not be scored at all');
});

/* ================================================================== */
/* the sizes people quote                                              */
/* ================================================================== */
check('dimensions come out in millimetres however they were written', () => {
  const d = dimensionsFrom(THREAD);
  const mm = d.map(x => x.mm);
  assert(mm.includes(600), `600mm was missed: ${mm}`);
  assert(mm.includes(100), `100mm was missed: ${mm}`);
  // 3/4 inch = 19.05mm, which is the number a person would need
  assert(mm.some(v => v === 19), `3/4 inch did not become 19mm: ${mm}`);
});

check('every unit a person might use is understood', () => {
  const cases = [['12mm', 12], ['4.5cm', 45], ['1.2m', 1200], ['2in', 51], ['6 inches', 152], ['3"', 76]];
  for (const [text, want] of cases) {
    const got = dimensionsFrom(`the part is ${text} across`)[0]?.mm;
    assert(got === want, `"${text}" came out as ${got}, expected ${want}`);
  }
});

check('a year is not a dimension, and neither is a like count', () => {
  const d = dimensionsFrom('Posted 2019. 4 years ago. 12 likes. 47 replies.');
  assert(d.length === 0, `it read the page furniture as sizes: ${JSON.stringify(d)}`);
});

check('nothing absurd gets through', () => {
  const d = dimensionsFrom('the bed is 0.02mm and the site is 40000mm wide and the part is 250mm');
  const mm = d.map(x => x.mm);
  assert(mm.includes(250), 'the real dimension was dropped');
  assert(!mm.some(v => v < 1 || v > 6000), `out-of-range values survived: ${mm}`);
});

check('the same measurement twice takes one slot', () => {
  const d = dimensionsFrom('600mm long. Cut it to 600mm. Yes, 600mm.');
  assert(d.filter(x => x.mm === 600).length === 1, 'duplicates are not being collapsed');
});

/* ================================================================== */
/* mining a set of pages                                               */
/* ================================================================== */
const PAGES = [
  { url: 'https://forum.example/bandsaw-fence', text: THREAD },
  { url: 'https://news.example/council', text: NEWS }
];
const REFS = [
  { source: 'web', url: 'https://forum.example/bandsaw-fence', title: 'Bandsaw fence build thread', summary: '' },
  { source: 'web', url: 'https://news.example/council', title: 'Council approves regulations', summary: '' }
];

check('the useful page is kept and the news page is thrown away', () => {
  const read = minePages(PAGES, REFS);
  assert(read.length === 1, `${read.length} pages kept: ${read.map(r => r.title)}`);
  assert(/Bandsaw/.test(read[0].title), read[0].title);
});

check('what it takes out of the page is what the planner could not guess', () => {
  const [r] = minePages(PAGES, REFS);
  assert(r.structure.includes('hardwood face'), `part names missed: ${JSON.stringify(r.structure)}`);
  assert(r.structure.some(s => /extrusion/.test(s)), `the extrusion was missed: ${JSON.stringify(r.structure)}`);
  assert(r.dimensions.length >= 2, `only ${r.dimensions.length} sizes`);
  assert(r.line && /\d/.test(r.line), `the quoted line has no number in it: "${r.line}"`);
  assert(!/Cookie|Facebook|Register/.test(r.line), `page furniture got quoted: "${r.line}"`);
});

check('a page with nothing in it contributes nothing rather than noise', () => {
  assert(minePages([{ url: 'https://x.test', text: NEWS }], []).length === 0, 'the news page was mined anyway');
  assert(minePages([], []).length === 0 && minePages(null, null).length === 0, 'empty input threw or invented');
});

check('the best page leads', () => {
  const thin = { url: 'https://b.test', text: THREAD.replace(/consists of[\s\S]*?block\./, '') + ' cut drill' };
  const read = minePages([thin, PAGES[0]], []);
  assert(read.length >= 1, 'nothing survived');
  assert(read[0].value >= (read[1]?.value ?? 0), 'not sorted by how much is in them');
});

/* ================================================================== */
/* which results are worth opening                                     */
/* ================================================================== */
check('the open web is opened, a fat API summary is not', () => {
  const pick = worthReading([
    { source: 'web', url: 'https://forum.example/thread', title: 'a', summary: '' },
    { source: 'wikipedia', url: 'https://en.wikipedia.org/x', title: 'b', summary: 'x'.repeat(400) },
    { source: 'thingiverse', url: 'https://thingiverse.com/thing:1', title: 'c', summary: 'y'.repeat(300) }
  ]);
  assert(pick.length === 1 && /forum/.test(pick[0]), `it chose ${JSON.stringify(pick)}`);
});

check('a thin summary from anywhere is worth opening', () => {
  const pick = worthReading([{ source: 'wikipedia', url: 'https://en.wikipedia.org/x', title: 'b', summary: 'short' }]);
  assert(pick.length === 1, 'a stub article should be opened rather than used as-is');
});

check('it does not try to read a binary', () => {
  const pick = worthReading([
    { source: 'web', url: 'https://x.test/manual.pdf', title: 'a', summary: '' },
    { source: 'web', url: 'https://x.test/model.stl', title: 'b', summary: '' },
    { source: 'web', url: 'ftp://x.test/thing', title: 'c', summary: '' },
    { source: 'web', url: 'https://x.test/page', title: 'd', summary: '' }
  ]);
  assert(pick.length === 1 && /page$/.test(pick[0]), `it would have fetched ${JSON.stringify(pick)}`);
});

check('it never opens more than a few', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ source: 'web', url: `https://x.test/${i}`, title: 'x', summary: '' }));
  assert(worthReading(many).length <= 3, 'a build would stall on page fetches');
});

/* ================================================================== */
/* routing                                                             */
/* ================================================================== */
check('every route reaches the open web now', () => {
  for (const d of ['making', 'propulsion', 'aerospace', 'mechanism', 'structure', 'vehicle', 'robotics', 'electronics']) {
    assert(sourcesFor(d).includes('web'), `${d} still cannot search the web`);
    for (const src of sourcesFor(d)) assert(SOURCES[src], `${d} routes to "${src}", which is not a source`);
  }
});

check('the web leads where the APIs are worst', () => {
  // electronics: Thingiverse has nothing, Wikipedia has a stub, and every
  // useful page is a datasheet or a forum post
  assert(sourcesFor('electronics')[0] === 'web', 'a circuit should go to the web first');
  // and a phone stand still asks the print sites first, because there the
  // published models genuinely are the best answer
  assert(sourcesFor('making')[0] === 'thingiverse', 'the maker route lost its priority');
});

/* ================================================================== */
/* into the prompt                                                     */
/* ================================================================== */
check('what was read reaches the planner, in its own section', () => {
  const read = minePages(PAGES, REFS);
  const block = readingBlock(read);
  assert(/hardwood face/.test(block), 'the part names did not make it into the prompt');
  assert(/600mm/.test(block), 'the sizes did not make it into the prompt');
  assert(/WROTE DOWN/.test(block), 'no heading — the planner cannot tell this apart from a listing');
  assert(readingBlock([]) === '' && readingBlock(null) === '', 'an empty read produced a block anyway');
});

check('the planner and the inspector both get it', () => {
  const read = minePages(PAGES, REFS);
  const sys = buildMessages('a bandsaw fence', null, [], read)[0].content;
  assert(/hardwood face/.test(sys), 'the planning prompt does not carry what was read');

  const crit = buildCritiqueMessages('a bandsaw fence', { title: 'x', steps: [] }, [], 'x', [], read)[0].content;
  assert(/hardwood face/.test(crit), 'the inspector cannot fail a build for missing a part every page mentions');
});

check('a build with nothing read is exactly as it was', () => {
  const withNothing = buildMessages('a desk lamp', null, [], []);
  const withNull = buildMessages('a desk lamp', null, [], null);
  assert(withNothing[0].content === withNull[0].content, 'an empty read changes the prompt');
  assert(!/WROTE DOWN/.test(withNothing[0].content), 'an empty reading block leaked in');
});

/* ================================================================== */
console.log(out.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
