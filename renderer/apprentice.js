/* ------------------------------------------------------------------ *
 * apprentice.js — what the floor builds when nobody has asked for anything
 * ------------------------------------------------------------------ *
 *
 * An apprentice left alone in a shop does not sit still, and does not build
 * the same stool forty times either. It goes after the thing it got wrong
 * last week, then the thing it has never tried.
 *
 * This used to be a strict priority cascade: repair, then gap, then stretch,
 * then vary, then whatever a lookup turned up. Four problems with that, all
 * of which showed up once the shop had a crew:
 *
 *   · It could not see the CREW. The most useful signal on this floor is
 *     which TRADE keeps going wrong — a specialist whose parts get coerced
 *     out of its own materials every build, or who keeps failing to deliver.
 *     A cascade over object classes cannot express "practise the thing that
 *     makes the electrical specialist work".
 *   · A cascade cannot weigh. "The lowest-confidence class" always beat
 *     "the trade that failed three times running", however weak the first
 *     signal and however strong the second.
 *   · Nothing was REVISITED. A class that passed once was never built again
 *     until its confidence fell, and confidence only falls if it is built.
 *   · It forgot everything on restart, so the curriculum began again from
 *     the stool every session.
 *
 * So selection is now SCORED. Every candidate is priced by how much it would
 * teach, penalised by how recently it was attempted, and the best one wins.
 * The cascade's order survives as the base prices — repair still outranks
 * novelty on an equal footing — but a strong signal can now beat a weak one
 * of a "higher" kind, which is the whole point of scoring anything.
 *
 * Still pure: a library and some counters in, one request out. The entire
 * study policy runs through hundreds of cycles in a test with no window,
 * which is the only way the failure that matters gets caught — GRINDING. An
 * agent that studies the same class over and over looks busy and learns
 * nothing.
 */

/* The ladder. Each rung is here because it forces something the rungs below
   it do not: the shelf is the first that needs a row array, the rover the
   first that needs parts on a side face AND rotation, the crane the first
   with a tree deep enough to test the settle pass.

   `needs` is new and load-bearing. The electrical rungs were always at the
   end with a comment saying they depend on the mechanical ones — a comment
   does not stop anything. A rung whose prerequisite is not on file is not
   offered, so the floor cannot be handed "a torch with a switch" before it
   can build the thing a torch is mounted in. */
export const CURRICULUM = [
  { request: 'a simple wooden stool', key: 'stool',              teaches: 'a top and legs — the first array',            trades: ['softgoods', 'structures'] },
  { request: 'a desk lamp with a cone shade', key: 'lamp',      teaches: 'a stack, and proportion',                     trades: ['structures', 'softgoods'] },
  { request: 'a bookshelf with four shelves', key: 'shelf',      teaches: 'a row array and a tall footprint',            trades: ['softgoods'] },
  { request: 'a model rocket with fins', key: 'rocket',           teaches: 'a ring array on a side face',                 trades: ['structures'] },
  { request: 'a four-wheeled rover with a mast', key: 'rover',   teaches: 'mirrored wheels, rotation, an offset',        trades: ['structures', 'softgoods'] },
  { request: 'a desk fan on a weighted base', key: 'fan',      teaches: 'a heavy base under a light top',              trades: ['structures'] },
  { request: 'a wall clock with hands', key: 'clock',            teaches: 'thin parts on a flat face',                   trades: ['softgoods'] },
  { request: 'a hand plane with a wooden body', key: 'plane',    teaches: 'an inset part and a shallow angle',           trades: ['softgoods'] },
  { request: 'a tower crane with a counterweight', key: 'crane', teaches: 'a deep tree and a real balance problem',      trades: ['structures'], needs: 'stool' },
  { request: 'a robot arm with a gripper', key: 'arm',         teaches: 'a chain of joints, each on the last',         trades: ['structures'], needs: 'crane' },
  /* The electrical rungs need the mechanical ones first — a circuit is
     mounted on a board and the board is mounted on something, so it has to
     be able to build the something. `needs` is what makes that real. */
  { request: 'a torch with a switch', key: 'torch',              teaches: 'its first loop — supply, switch, resistor, LED, back', trades: ['electrical'], needs: 'lamp' },
  { request: 'a buzzer alarm on a 1.5V cell', key: 'buzzer',      teaches: 'a different supply and a different load',     trades: ['electrical'], needs: 'torch' },
  { request: 'a circuit that runs a small motor', key: 'motor',  teaches: 'a load that draws real current',              trades: ['electrical'], needs: 'torch' }
];

/* The engineering domains, as requests. The print sites have nothing for
   these, so they exercise the whole reference-routing path as well as the
   solver. */
export const STRETCH = [
  { request: 'a turbofan engine',                domain: 'propulsion', trades: ['structures'] },
  { request: 'a glider wing with ailerons',      domain: 'aerospace',  trades: ['structures', 'softgoods'] },
  { request: 'a two-stage gearbox',              domain: 'mechanism',  trades: ['structures'] },
  { request: 'a truss bridge span',              domain: 'structure',  trades: ['structures'] },
  { request: 'a go-kart chassis',                domain: 'vehicle',    trades: ['structures'] },
  { request: 'a robot arm on a fixed base',      domain: 'robotics',   trades: ['structures'] },
  { request: 'a two-transistor blinker circuit', domain: 'electronics', trades: ['electrical'] }
];

/* TRADE DRILLS — new, and the reason this file knows about the crew.

   When one specialist is the problem, the useful thing to practise is not
   "a class with low confidence", it is an object that CANNOT BE BUILT
   without that trade doing real work. Each of these is chosen so the trade
   in question owns the parts that make the object read as itself: take the
   softgoods out of a lampshade and it is a stick. */
export const DRILLS = {
  structures: [
    { request: 'a folding workbench with a steel frame', teaches: 'a frame that has to carry a top' },
    { request: 'a bracket that holds a shelf off a wall', teaches: 'a load path with a moment in it' },
    { request: 'a tripod stand with adjustable legs',     teaches: 'three legs and a real balance problem' }
  ],
  softgoods: [
    { request: 'a cardboard shipping crate with a lid',   teaches: 'panels that enclose a volume' },
    { request: 'a lampshade on a wire frame',             teaches: 'a skin over somebody else’s structure' },
    { request: 'a plywood speaker cabinet',               teaches: 'a box that has to look like a box' }
  ],
  electrical: [
    { request: 'a battery-powered LED lantern',           teaches: 'a loop that closes, on a body' },
    { request: 'a doorbell with a push switch and buzzer', teaches: 'switching a load' },
    { request: 'a night light with a resistor and an LED', teaches: 'sizing a limiter for a real supply' }
  ],
  powerplant: [
    { request: 'an inline four engine',                    teaches: 'a block, a crank and cylinders that agree with each other' },
    { request: 'a V8 engine',                              teaches: 'two banks at an angle off one crank' },
    { request: 'a high-bypass turbofan',                   teaches: 'stages in the right order along one shaft' },
    { request: 'a brushless outrunner motor',              teaches: 'a rotor that has to clear its own stator' }
  ],
  controls: [
    { request: 'a desk lamp that must fold flat',          teaches: 'a requirement that constrains geometry' },
    { request: 'a stool that must take 120kg',             teaches: 'a number the whole build is judged on' },
    { request: 'a phone stand with a 60 degree back',      teaches: 'an angle that is the point of the object' }
  ]
};

/* Ways of asking for a thing it already knows, to find out whether the
   recipe generalises or is welded to one phrasing. */
const VARIATIONS = [
  c => `a tall narrow ${c}`,
  c => `a wide low ${c}`,
  c => `a ${c} made of metal`,
  c => `a heavier ${c} with a wider base`,
  c => `a minimal ${c} with as few parts as possible`
];

export const STUDY_AFTER_MS = 45_000;   // idle this long and it finds something to do
export const COOLDOWN = 6;              // projects to get through before repeating one

/* Spaced repetition, in units of projects rather than days — the shop's
   clock is how much it has built, not how long it has been running. A class
   nobody has revisited in this many projects is worth another look even if
   its confidence is fine, because a recipe that is never re-tested is a
   recipe nobody has checked. */
export const REVIEW_AFTER = 12;

/* Three unsound builds in a row and it stops. Unattended study can be
   allowed to spend a key; it cannot be allowed to spend one all night on a
   request that fails identically every time. This is the difference between
   an apprentice and a runaway loop. */
export const FAIL_STREAK_STOP = 3;

/* ------------------------------------------------------------------ */
/* scoring                                                             */
/* ------------------------------------------------------------------ */
/* Base worth of each kind of project, and the ONE place the old cascade's
   priority order still lives. Everything below adjusts these rather than
   short-circuiting, so a strong signal of a "lower" kind can win. */
const WORTH = {
  repair: 60,     // a class on file that is not right yet
  drill: 55,      // a trade that keeps going wrong
  gap: 50,        // a rung never climbed
  review: 34,     // something that worked, unchecked for a long time
  stretch: 30,    // a domain never attempted
  vary: 20,       // does the recipe generalise
  world: 14       // a real published design
};

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
const classOf = req => norm(req).split(' ').filter(w => w.length > 2).at(-1) || '';

/* Every rung carries a stable `key` — the one word the shop would call the
   thing it built. `needs` names one of those keys, and a rung is unlocked
   when a skill on file looks like it.

   The match is both directions on purpose. The class a skill ends up filed
   under is whatever the reflection decided to call it, so a crane can land
   as "crane", "tower crane" or "towercrane", and a prerequisite that only
   matched one of those would lock a rung out of the syllabus permanently
   with nothing anywhere saying so. */
export const CURRICULUM_KEYS = () => CURRICULUM.map(c => c.key);
function satisfied(need, known) {
  const n = norm(need);
  for (const k of known.keys()) {
    const kk = norm(k);
    if (kk === n || kk.includes(n) || n.includes(kk)) return true;
  }
  return false;
}

/* How recently this was attempted, as a penalty rather than a hard filter.
   A flat ring buffer meant a genuinely urgent repair could be blocked by
   five things it had happened to try first. */
function staleness(request, done) {
  const i = done.map(norm).lastIndexOf(norm(request));
  if (i < 0) return 0;
  const ago = done.length - 1 - i;
  if (ago >= COOLDOWN) return 0;
  return 100 * (1 - ago / COOLDOWN);          // just done → -100, COOLDOWN ago → 0
}

/* Which trades a build actually exercised, out of the tally the floor keeps.
   `crew` is per-trade counters accumulated over recent builds:
     delivered  parts handed back
     coerced    parts pulled back into the trade's own materials
     dropped    parts over budget and thrown away
     failed     briefs that came back with nothing
   A trade that is failing or being coerced is a trade whose prompts are not
   working, and the fix is practice on something that forces it to engage. */
export function weakestTrade(crew = {}) {
  let worst = null, worstScore = 0;
  for (const [id, c] of Object.entries(crew)) {
    if (!DRILLS[id]) continue;
    const n = Math.max(1, (c.builds || 0));
    /* A failure is worth more than a coercion, which is worth more than a
       drop — failing to deliver at all is the loudest signal there is. */
    const score = ((c.failed || 0) * 3 + (c.coerced || 0) * 2 + (c.dropped || 0)) / n;
    if (score > worstScore) { worstScore = score; worst = id; }
  }
  return worstScore >= 0.5 ? { trade: worst, score: worstScore } : null;
}

/* ------------------------------------------------------------------ */
/* choosing                                                            */
/* ------------------------------------------------------------------ */
/*   skills   the library as it stands
 *   done     requests already attempted, most recent last (persisted)
 *   refs     whatever the last reference lookup turned up, if anything
 *   crew     per-trade counters from recent builds
 *   built    how many projects this shop has completed, ever
 */
export function candidates({ skills = [], done = [], refs = [], crew = {}, built = 0 } = {}) {
  const out = [];
  const known = new Map(skills.map(s => [s.class, s]));
  const add = (kind, request, why, bonus = 0, extra = {}) => {
    if (!request) return;
    out.push({ request, kind, why, score: WORTH[kind] + bonus - staleness(request, done), ...extra });
  };

  /* 1 — repair. The lowest-confidence class that has actually been built.
     A taught skill is the person's and practice does not get to overwrite
     it. The worse it is, the more the repair is worth — that is the bonus,
     and it is what lets a really bad recipe outrank a novel rung. */
  for (const s of skills) {
    if (!s.recipe?.parts?.length || s.stats?.taught) continue;
    const conf = s.confidence ?? 1;
    /* Below half. The threshold has to sit UNDER what a sound study build is
       worth, or it repairs a class, files it at the self-taught ceiling,
       finds it still below the bar, and repairs it forever. */
    if (conf >= 0.5) continue;
    add('repair', s.sourceRequests?.[0] || `a ${s.class}`,
      `built before and only ${Math.round(conf * 100)}% right — worth another go`,
      (0.5 - conf) * 60, { cls: s.class });
  }

  /* 2 — the trade that keeps going wrong. New, and usually the most useful
     thing on the list when it fires at all. */
  const weak = weakestTrade(crew);
  if (weak) {
    for (const d of DRILLS[weak.trade] || []) {
      add('drill', d.request,
        `${weak.trade} has been going wrong — this cannot be built without it, and it teaches ${d.teaches}`,
        Math.min(30, weak.score * 20), { trade: weak.trade });
    }
  }

  /* 3 — the next rung never climbed, prerequisites respected. */
  for (const c of CURRICULUM) {
    if (satisfied(c.key, known) || known.has(classOf(c.request))) continue;
    if (c.needs && !satisfied(c.needs, known)) continue;
    /* Earlier rungs are worth more, so the ladder is still a ladder. */
    add('gap', c.request, `never built one, and it teaches ${c.teaches}`,
      Math.max(0, 12 - CURRICULUM.indexOf(c)), { teaches: c.teaches });
  }

  /* 4 — spaced review. Something that worked and has not been looked at in
     a long time. A recipe nobody re-tests is a recipe nobody has checked. */
  for (const s of skills) {
    if (!s.recipe?.parts?.length || s.stats?.taught) continue;
    const age = built - (s.stats?.lastBuilt ?? 0);
    if (age < REVIEW_AFTER) continue;
    add('review', s.sourceRequests?.[0] || `a ${s.class}`,
      `nothing has re-tested the ${s.class} recipe in ${age} projects`,
      Math.min(20, age - REVIEW_AFTER), { cls: s.class });
  }

  /* 5 — a domain never attempted at all. */
  for (const s of STRETCH) {
    if (known.has(classOf(s.request))) continue;
    add('stretch', s.request, `nothing in the library is ${s.domain} — this is new ground`, 0, { domain: s.domain });
  }

  /* 6 — take something it knows and ask for it differently. */
  for (const s of skills) {
    if (!s.recipe?.parts?.length) continue;
    for (const v of VARIATIONS) {
      add('vary', v(s.class),
        `it can build a ${s.class} — this finds out whether it understands one or just remembers one`,
        (s.confidence ?? 0) * 8, { cls: s.class });
    }
  }

  /* 7 — something real, off the back of a lookup. */
  for (const r of refs || []) {
    const t = trimTitle(r.title || '');
    if (t.length > 6) add('world', t, 'a real published design it has not attempted');
  }

  return out.sort((a, b) => b.score - a.score);
}

export function nextProject(ctx = {}) {
  const list = candidates(ctx);
  /* Anything still inside its cooldown scored below zero. Taking one anyway
     would be grinding, which is the failure this whole file exists to
     prevent — a full shop is not a failure, it is a full shop. */
  const pick = list.find(c => c.score > 0);
  if (!pick) return null;
  /* The extras ride along. A drill without its trade on it is a drill the
     caller cannot report, cannot count and cannot tell from a gap. */
  return { ...pick, score: Math.round(pick.score) };
}

/* What it would do next and why, for the person who wants to know rather
   than wait and see. This is the syllabus, and it is the same list the
   picker uses — a plan that is computed differently from the thing it
   describes is a plan that is wrong. */
export function studyReport(ctx = {}) {
  const list = candidates(ctx).slice(0, 8);
  const weak = weakestTrade(ctx.crew || {});
  return {
    next: list.find(c => c.score > 0) || null,
    weakTrade: weak,
    queue: list.map(c => ({ request: c.request, kind: c.kind, why: c.why, score: Math.round(c.score), ready: c.score > 0 })),
    /* An empty queue means everything is either recent or already known,
       which is a shop that has run out of syllabus rather than a bug. */
    exhausted: !list.some(c => c.score > 0)
  };
}

/* ------------------------------------------------------------------ */
/* when                                                                */
/* ------------------------------------------------------------------ */
/* It studies only when the shop is genuinely idle. Every one of these is a
   reason not to: the person is mid-build, the bench is open and being worked
   in, something was typed a moment ago, the palette is open. Being wrong
   about this is worse than never studying — an app that starts animating
   while you are reading it is an app you turn off. */
export function shouldStudy({ on, busy, idleMs, benchOpen, typing, studying, paletteOpen = false, failStreak = 0 }) {
  if (!on || busy || studying) return false;
  if (benchOpen || typing || paletteOpen) return false;
  /* The runaway guard. Three unsound builds in a row is not bad luck, it is
     something wrong that practice will not fix, and the shop should stop
     rather than spend the night proving it. */
  if (failStreak >= FAIL_STREAK_STOP) return false;
  return idleMs >= STUDY_AFTER_MS;
}

/* ------------------------------------------------------------------ */
/* what it was worth                                                   */
/* ------------------------------------------------------------------ */
/* A study build is only allowed to teach something if it came out sound.
   This is the guard on the whole loop: an agent that trains on its own
   unchecked output drifts, and it drifts fastest when it is confident.

   What is new is that "not sound" is no longer one bucket. A build that
   fell over and a build with a cosmetic finding are different failures and
   were being priced the same — which meant a nearly-right recipe was thrown
   away as readily as a heap. */
export function studyOutcome({ issues = [], metrics, findings = [], crew = null } = {}) {
  const faults = findings.filter(f => f.severity === 'fault');
  const topples = metrics?.stable === false;
  const sound = !issues.length && !topples && !faults.length;

  /* A trade that came back empty or had its parts taken off it is worth
     recording even on a build that otherwise passed — it is the signal the
     drill selector runs on, and it is invisible in the geometry. */
  const tradeTrouble = crew
    ? Object.entries(crew).filter(([, c]) => (c.failed || 0) || (c.coerced || 0)).map(([id]) => id)
    : [];

  const grade = sound ? (tradeTrouble.length ? 'sound' : 'clean')
    : topples ? 'unstable'
      : faults.length ? 'faulty' : 'unsound';

  return {
    sound,
    grade,
    // a recipe only goes on file if the thing built actually worked
    keepRecipe: sound,
    /* A clean build with nobody in trouble is worth more than a sound one
       where a trade had to be corrected — but both stay under the ceiling
       that stops self-study rotting the library. */
    confidence: grade === 'clean' ? 0.58 : grade === 'sound' ? 0.52 : grade === 'faulty' ? 0.32 : 0.3,
    note: sound
      ? (tradeTrouble.length
        ? `it came out sound, but ${tradeTrouble.join(' and ')} had to be corrected — filed as a recipe`
        : 'it came out clean — filed as a recipe')
      : topples ? 'it falls over — lessons only, no recipe'
        : faults.length ? `${faults[0].title.toLowerCase()} — lessons only, no recipe`
          : 'it did not pass inspection — lessons only, no recipe',
    tradeTrouble,
    lessons: [
      ...issues.slice(0, 2).map(s => String(s).slice(0, 180)),
      ...faults.slice(0, 2).map(f => `${f.title}: ${f.why}`.slice(0, 180)),
      ...(topples ? ['the centre of mass sat outside the footprint — it toppled'] : [])
    ]
  };
}

/* Fold one build's crew tally into the running counters the drill selector
   reads. Kept here rather than in app.js because it is policy, not display:
   what counts as a trade "going wrong" is the apprenticeship's opinion. */
export function recordCrew(crew = {}, ledgerTasks = []) {
  const next = { ...crew };
  for (const t of ledgerTasks) {
    if (!DRILLS[t.role]) continue;
    const c = next[t.role] = { ...(next[t.role] || { builds: 0, delivered: 0, coerced: 0, dropped: 0, failed: 0 }) };
    c.builds++;
    if (t.status === 'failed' || t.status === 'denied') c.failed++;
    c.delivered += t.delivered || 0;
    c.coerced += t.coerced || 0;
    c.dropped += t.dropped || 0;
  }
  return next;
}

/* ------------------------------------------------------------------ */
/* A published title is a sales pitch — "Fully Articulated Dragon v3 (no
   supports!)" is not a build request. Take the front of it. */
function trimTitle(t) {
  return String(t)
    .replace(/\(.*?\)/g, ' ')
    .replace(/\b(v\d+|mk\d+|remix|updated|improved|no supports?|easy print|print in place)\b/gi, ' ')
    .replace(/[^a-zA-Z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ').slice(0, 5).join(' ')
    .toLowerCase();
}
