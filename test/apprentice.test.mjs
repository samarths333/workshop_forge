/* The apprenticeship.

   Two failures are being defended here, and neither of them looks like a bug
   while it is happening.

   GRINDING. An agent that studies the same class over and over looks busy
   and learns nothing. The old cascade could not weigh signals against each
   other, so it was possible for a genuinely urgent repair to sit behind five
   things that happened to be tried first. Scoring fixes that and introduces
   its own risk — a bonus that is too large turns into a loop — so the loop
   is actually run, hundreds of times, and the spread of what it chose is
   asserted on.

   BURNING A KEY OVERNIGHT. Unattended study is allowed to spend a key. It is
   not allowed to spend one all night on a request that fails identically
   every time, which is what "keep practising until you get it right" does
   when the thing that is wrong is not something practice fixes.

     node test/apprentice.test.mjs
*/
import {
  nextProject, candidates, studyReport, shouldStudy, studyOutcome,
  weakestTrade, recordCrew,
  CURRICULUM, STRETCH, DRILLS, STUDY_AFTER_MS, COOLDOWN, REVIEW_AFTER, FAIL_STREAK_STOP
} from '../renderer/apprentice.js';
import { SPECIALISTS } from '../renderer/roles.js';

let pass = 0, fail = 0;
const out = [];
const check = (name, fn) => {
  try { fn(); pass++; out.push(`  ok    ${name}`); }
  catch (e) { fail++; out.push(`  FAIL  ${name}\n          ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

const skill = (cls, over = {}) => ({
  class: cls, name: cls, confidence: 0.8,
  recipe: { parts: [{ name: 'p', shape: 'box', material: 'metal', size: [1, 1, 1] }] },
  stats: { uses: 1, taught: 0, lastBuilt: 0 },
  sourceRequests: [`a ${cls}`],
  ...over
});
const classOf = req => req.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(' ').filter(w => w.length > 2).at(-1);

/* ------------------------------------------------------------------ */
/* the syllabus                                                        */
/* ------------------------------------------------------------------ */
check('the ladder is a ladder, and every rung says what it is for', () => {
  assert(CURRICULUM.length >= 10, `only ${CURRICULUM.length} rungs`);
  const seen = new Set();
  for (const c of CURRICULUM) {
    assert(c.request && c.teaches, `${c.request} does not say what it teaches`);
    assert(!seen.has(c.request), `"${c.request}" is on the ladder twice`);
    seen.add(c.request);
    for (const t of c.trades || []) assert(DRILLS[t] || t === 'structures', `${c.request} names trade "${t}"`);
  }
  /* A prerequisite that names something no other rung produces can never be
     satisfied, which silently removes that rung from the syllabus forever
     and nothing anywhere says so. */
  const keys = new Set(CURRICULUM.map(c => c.key));
  for (const c of CURRICULUM) {
    assert(c.key, `"${c.request}" has no key, so nothing can depend on it`);
    if (!c.needs) continue;
    assert(keys.has(c.needs), `"${c.request}" needs "${c.needs}", which no rung produces`);
    assert(CURRICULUM.findIndex(x => x.key === c.needs) < CURRICULUM.indexOf(c),
      `"${c.request}" needs "${c.needs}", which comes after it on the ladder`);
  }
});

check('every trade that can go wrong has something to practise on', () => {
  for (const r of SPECIALISTS) {
    assert(DRILLS[r.id]?.length >= 2, `${r.id} has ${DRILLS[r.id]?.length || 0} drills — a weak trade would have nothing to work on`);
    for (const d of DRILLS[r.id]) assert(d.request && d.teaches, `a ${r.id} drill says nothing about itself`);
  }
});

/* ------------------------------------------------------------------ */
/* choosing                                                            */
/* ------------------------------------------------------------------ */
check('an empty shop starts at the bottom of the ladder', () => {
  const p = nextProject({ skills: [], done: [] });
  assert(p, 'a fresh shop found nothing to do');
  assert(p.request === CURRICULUM[0].request, `it started with "${p.request}"`);
  assert(p.kind === 'gap' && p.why.length > 10, `${p.kind}: ${p.why}`);
});

check('a rung whose prerequisite is missing is not offered', () => {
  /* The electrical rungs used to sit at the end of an array with a comment
     saying they need the mechanical ones first. A comment does not stop
     anything, and a shop handed "a torch with a switch" as its first ever
     project has to invent the thing the torch is mounted in. */
  const first = candidates({ skills: [], done: [] }).filter(c => c.kind === 'gap');
  const torch = first.find(c => /torch/.test(c.request));
  assert(!torch, 'the torch was offered before anything it mounts on exists');

  const withLamp = candidates({ skills: [skill('lamp')], done: [] }).filter(c => c.kind === 'gap');
  assert(withLamp.some(c => /torch/.test(c.request)), 'the torch stayed locked after its prerequisite was built');
});

check('a bad recipe outranks a novel one, and a worse one outranks a bad one', () => {
  const mild = nextProject({ skills: [skill('stool', { confidence: 0.45 })], done: [] });
  assert(mild.kind === 'repair' && /stool/.test(mild.request), `${mild.kind}: ${mild.request}`);

  /* Scoring, not a cascade: the worse of two repairs has to win. A cascade
     took whichever was first in the array. */
  const two = nextProject({
    skills: [skill('stool', { confidence: 0.45 }), skill('lamp', { confidence: 0.12 })],
    done: []
  });
  assert(/lamp/.test(two.request), `it repaired the ${two.request} while the lamp was at 12%`);
});

check('a hand-taught recipe is never practised over', () => {
  const taught = skill('lamp', { confidence: 0.2, stats: { uses: 3, taught: 2, lastBuilt: 0 } });
  const list = candidates({ skills: [taught], done: [], built: 99 });
  assert(!list.some(c => c.kind === 'repair'), 'a taught recipe was queued for repair');
  assert(!list.some(c => c.kind === 'review'), 'a taught recipe was queued for review');
});

check('the trade that keeps going wrong is what gets practised', () => {
  /* THE POINT OF KNOWING ABOUT THE CREW. A cascade over object classes
     cannot express "the electrical specialist has failed three builds
     running", which is the most actionable thing the floor knows. */
  const crew = {
    structures: { builds: 4, delivered: 12, coerced: 0, dropped: 0, failed: 0 },
    electrical: { builds: 4, delivered: 1, coerced: 3, dropped: 0, failed: 3 }
  };
  const weak = weakestTrade(crew);
  assert(weak?.trade === 'electrical', `weakest trade came out as ${weak?.trade}`);

  const p = nextProject({ skills: [skill('stool')], done: [], crew });
  assert(p.kind === 'drill' && p.trade === 'electrical', `${p.kind} / ${p.trade}: ${p.request}`);
  assert(DRILLS.electrical.some(d => d.request === p.request), `"${p.request}" is not an electrical drill`);
  assert(/electrical/.test(p.why), `the reason does not mention the trade: ${p.why}`);
});

check('a floor where nobody is struggling is not sent on drills', () => {
  const happy = {
    structures: { builds: 6, delivered: 18, coerced: 0, dropped: 0, failed: 0 },
    softgoods: { builds: 6, delivered: 12, coerced: 0, dropped: 1, failed: 0 }
  };
  assert(!weakestTrade(happy), 'a healthy floor was reported as weak');
  const list = candidates({ skills: [skill('stool')], done: [], crew: happy });
  assert(!list.some(c => c.kind === 'drill'), 'drills were queued with nothing wrong');
});

check('something that worked but has not been re-tested comes back round', () => {
  /* Spaced repetition. A recipe nobody re-tests is a recipe nobody has
     checked, and the old policy only revisited a class once its confidence
     fell — which could not happen, because confidence only moves when it is
     built. */
  const old = skill('stool', { confidence: 0.7, stats: { uses: 1, taught: 0, lastBuilt: 1 } });
  const fresh = candidates({ skills: [old], done: [], built: 2 });
  assert(!fresh.some(c => c.kind === 'review'), 'a recipe built two projects ago was queued for review');

  const stale = candidates({ skills: [old], done: [], built: 1 + REVIEW_AFTER + 5 });
  const review = stale.find(c => c.kind === 'review');
  assert(review, `nothing was reviewed after ${REVIEW_AFTER + 5} projects`);
  assert(/re-test/.test(review.why), review.why);
});

check('it does not grind — a hundred cycles produce a spread, not a loop', () => {
  /* The failure this whole file exists to prevent, run rather than argued.
     Scoring introduces its own version of it: a bonus set too high becomes
     a fixed point the picker never leaves. */
  const skills = [];
  const done = [];
  const counts = {};
  let built = 0;

  for (let i = 0; i < 100; i++) {
    const p = nextProject({ skills, done, built });
    if (!p) { done.length = Math.max(0, done.length - 3); continue; }   // shop full: let the buffer move on
    counts[p.request] = (counts[p.request] || 0) + 1;
    done.push(p.request);
    built++;
    const cls = classOf(p.request);
    const existing = skills.find(s => s.class === cls);
    if (existing) { existing.confidence = Math.min(0.6, existing.confidence + 0.1); existing.stats.lastBuilt = built; }
    else skills.push(skill(cls, { confidence: 0.55, stats: { uses: 1, taught: 0, lastBuilt: built } }));
  }

  const distinct = Object.keys(counts).length;
  assert(distinct >= 18, `only ${distinct} distinct projects in 100 cycles — that is grinding`);
  const worst = Math.max(...Object.values(counts));
  assert(worst <= 12, `one project came up ${worst} times in 100`);

  // and it should have got somewhere: most of the ladder attempted
  const climbed = CURRICULUM.filter(c => counts[c.request]).length;
  assert(climbed >= CURRICULUM.length - 4, `only climbed ${climbed} of ${CURRICULUM.length} rungs in 100 projects`);
});

check('a project just attempted is not attempted again immediately', () => {
  const done = ['a simple wooden stool'];
  const p = nextProject({ skills: [], done });
  assert(p.request !== done[0], 'it went straight back to the thing it just built');

  /* Cooldown is a penalty now, not a filter — so a really urgent repair CAN
     come back inside it, which is correct, but not on the very next turn. */
  const justDone = candidates({ skills: [], done: ['a simple wooden stool'] })
    .find(c => c.request === 'a simple wooden stool');
  assert(!justDone || justDone.score <= 0, `the thing just built still scores ${justDone?.score}`);
});

check('a full shop stops rather than repeating itself', () => {
  const skills = [...CURRICULUM, ...STRETCH].map(c => skill(classOf(c.request), { confidence: 0.95 }));
  const done = [...CURRICULUM, ...STRETCH].map(c => c.request).slice(-COOLDOWN);
  const p = nextProject({ skills, done, built: 3 });
  // it may legitimately find a variation; what it must not do is repeat a cooled item
  if (p) assert(!done.includes(p.request), `it repeated "${p.request}" while it was on cooldown`);
});

check('the syllabus it reports is the syllabus it uses', () => {
  /* A plan computed differently from the thing it describes is a plan that
     is wrong, and it is wrong in the least visible way possible. */
  const ctx = { skills: [skill('stool', { confidence: 0.3 })], done: [], crew: {}, built: 5 };
  const report = studyReport(ctx);
  const picked = nextProject(ctx);
  assert(report.next?.request === picked.request, `report says ${report.next?.request}, picker says ${picked.request}`);
  assert(report.queue.length > 1, 'the report shows no queue');
  assert(report.queue.every(q => q.why && q.kind), 'a queued item does not say why it is there');
  assert(report.queue[0].score >= report.queue[1].score, 'the queue is not ordered');
  assert(!report.exhausted, 'a shop with work to do reported itself exhausted');
});

/* ------------------------------------------------------------------ */
/* when                                                                */
/* ------------------------------------------------------------------ */
check('it only starts when the shop is genuinely quiet', () => {
  const base = { on: true, busy: false, idleMs: STUDY_AFTER_MS + 1, benchOpen: false, typing: false, studying: false };
  assert(shouldStudy(base), 'an idle shop with study on should start');
  assert(!shouldStudy({ ...base, on: false }), 'it started with study switched off');
  assert(!shouldStudy({ ...base, busy: true }), 'it started mid-build');
  assert(!shouldStudy({ ...base, benchOpen: true }), 'it started while the bench was open');
  assert(!shouldStudy({ ...base, typing: true }), 'it started while someone was typing');
  assert(!shouldStudy({ ...base, studying: true }), 'it started a second project on top of the first');
  assert(!shouldStudy({ ...base, idleMs: 1000 }), 'it started after one second of quiet');
  assert(!shouldStudy({ ...base, paletteOpen: true }), 'it started animating while the palette was open');
});

check('it stops after a run of failures instead of spending all night', () => {
  /* Practice fixes a bad recipe. It does not fix a wrong API key, a model
     that will not emit JSON, or a request nothing can build — and those all
     look exactly like a bad recipe from in here. */
  const base = { on: true, busy: false, idleMs: STUDY_AFTER_MS + 1, benchOpen: false, typing: false, studying: false };
  assert(shouldStudy({ ...base, failStreak: FAIL_STREAK_STOP - 1 }), 'it gave up too early');
  assert(!shouldStudy({ ...base, failStreak: FAIL_STREAK_STOP }), `it kept going after ${FAIL_STREAK_STOP} failures in a row`);
  assert(!shouldStudy({ ...base, failStreak: 99 }), 'it kept going forever');
});

/* ------------------------------------------------------------------ */
/* what a study build was worth                                        */
/* ------------------------------------------------------------------ */
check('only a sound build files a recipe', () => {
  const clean = studyOutcome({ issues: [], metrics: { stable: true }, findings: [] });
  assert(clean.sound && clean.keepRecipe, 'a clean build filed nothing');
  assert(clean.grade === 'clean', clean.grade);
  assert(clean.confidence < 0.6, `a self-taught build was filed at ${clean.confidence} — that is above the ceiling`);

  const toppled = studyOutcome({ issues: [], metrics: { stable: false }, findings: [] });
  assert(!toppled.keepRecipe, 'a build that falls over filed a recipe');
  assert(toppled.grade === 'unstable', toppled.grade);
  assert(toppled.lessons.some(l => /topple|outside the footprint/i.test(l)), 'it did not record why it fell over');

  const faulty = studyOutcome({
    issues: ['the shade floats'], metrics: { stable: true },
    findings: [{ severity: 'fault', title: 'Cardboard under load', why: 'a card leg holds 40kg' }]
  });
  assert(!faulty.keepRecipe, 'a faulty build filed a recipe');
  assert(faulty.lessons.length >= 2, 'the lessons were not kept');
});

check('a build nobody had to be corrected on is worth more than one they did', () => {
  /* Both stay under the self-taught ceiling — that is what stops overnight
     practice rotting the library — but they are not the same build and were
     being priced as though they were. */
  const clean = studyOutcome({ issues: [], metrics: { stable: true }, findings: [], crew: { structures: { failed: 0, coerced: 0 } } });
  const messy = studyOutcome({ issues: [], metrics: { stable: true }, findings: [], crew: { electrical: { failed: 1, coerced: 2 } } });
  assert(clean.confidence > messy.confidence, `clean ${clean.confidence} vs corrected ${messy.confidence}`);
  assert(messy.keepRecipe, 'a sound build was thrown away because a trade needed correcting');
  assert(messy.tradeTrouble.includes('electrical'), 'the trade that struggled was not recorded');
  assert(/electrical/.test(messy.note), messy.note);
  for (const o of [clean, messy]) assert(o.confidence < 0.6, `${o.grade} filed at ${o.confidence}`);
});

check('what the crew did on a build reaches the counters the drills read', () => {
  let crew = {};
  crew = recordCrew(crew, [
    { role: 'structures', status: 'delivered', delivered: 3, coerced: 0, dropped: 0 },
    { role: 'electrical', status: 'failed', delivered: 0, coerced: 0, dropped: 0 },
    { role: 'foreman', status: 'delivered', delivered: 1 }
  ]);
  assert(crew.structures.builds === 1 && crew.structures.delivered === 3, JSON.stringify(crew.structures));
  assert(crew.electrical.failed === 1, JSON.stringify(crew.electrical));
  assert(!crew.foreman, 'the foreman was counted as a trade that can be drilled');

  crew = recordCrew(crew, [{ role: 'electrical', status: 'failed', delivered: 0 }]);
  crew = recordCrew(crew, [{ role: 'electrical', status: 'failed', delivered: 0 }]);
  assert(crew.electrical.builds === 3 && crew.electrical.failed === 3, JSON.stringify(crew.electrical));
  assert(weakestTrade(crew)?.trade === 'electrical', 'three failures running did not make it the weakest trade');
});

console.log(out.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
