/* =====================================================================
   The reference library.

   Thingiverse and Printables answer "how do people make a phone stand".
   They are useless for "a turbofan", "a wing", "a differential" — search
   either one for an engine and you get a keychain shaped like one. The
   things people publish there are the things that print in four hours, and
   the whole class of objects that are actually interesting to build is
   exactly the class that is missing.

   So requests get routed. A maker-ish request goes to the maker sites; an
   engineering request goes to sources that describe how the real thing is
   put together — Wikipedia for structure and vocabulary, Wikimedia Commons
   for schematics and cutaways, NASA's technical reports for anything that
   flies, Openverse for openly-licensed diagrams.

   And because a build must never depend on the network, every engineering
   domain also carries a hand-written parts vocabulary. A turbofan has a
   fan, a compressor, a combustor and a turbine whether or not an API
   answered, and handing the planner those eight words is most of the
   difference between a plausible engine and a cylinder with a cone on it.

   Imports nothing. Routing, extraction and prompt assembly are all pure
   string work, and all of it is checked in node.
   ===================================================================== */

export const SOURCES = {
  thingiverse: { label: 'Thingiverse', kind: 'making',      note: 'printable designs, openly licensed' },
  printables:  { label: 'Printables',  kind: 'making',      note: 'printable designs, best effort' },
  wikipedia:   { label: 'Wikipedia',   kind: 'engineering', note: 'what the real thing is made of' },
  commons:     { label: 'Commons',     kind: 'engineering', note: 'schematics, cutaways, diagrams' },
  ntrs:        { label: 'NASA NTRS',   kind: 'engineering', note: 'aerospace technical reports' },
  openverse:   { label: 'Openverse',   kind: 'engineering', note: 'openly licensed diagrams' },
  /* The one that covers everything the APIs do not: forums, build
     threads, maker blogs, supplier spec pages. Read rather than listed —
     a title is what the shop already had and it was not enough. */
  web:         { label: 'the web',     kind: 'engineering', note: 'read in full, for how it is actually made' }
};

/* ------------------------------------------------------------------ */
/* what kind of thing is this                                          */
/* ------------------------------------------------------------------ */
/* Ordered: the first domain that matches wins, so the specific patterns
   come before the general ones. "rocket engine" is propulsion, not a
   rocket; "landing gear" is aerospace, not a mechanism. */
const DOMAINS = [
  /* Electronics goes first on purpose. "motor" appears in the propulsion
     vocabulary, so "a circuit with a motor and a switch" would otherwise
     be routed to jet engines — and the specific reading has to win. */
  {
    id: 'electronics',
    label: 'circuits and electronics',
    re: /\b(circuit|electronic|electrical|pcb|breadboard|led|resistor|capacitor|transistor|diode|arduino|amplifier|oscillator|blink|torch|flashlight|power supply|voltage|solder|buzzer|relay|battery)\w*\b/,
    parts: ['board', 'power supply', 'switch', 'series resistor', 'indicator LED', 'load', 'return path'],
    note: 'A circuit is a loop, not a stack. Current leaves the supply\'s positive terminal, passes through every part in turn and returns to the negative terminal; anything not on that loop does nothing at all. Every LED has a resistor in series to set its current. A switch goes in the loop, never across it, and the two sides of the supply never meet without a load between them.'
  },
  {
    id: 'propulsion',
    label: 'engines and propulsion',
    re: /\b(engine|turbofan|turbojet|turboprop|turbine|jet|combustor|piston|crankshaft|camshaft|cylinder head|carburett?or|injector|exhaust manifold|thruster|nozzle|impeller|supercharger|turbocharger|motor|magneto)\b/,
    parts: ['inlet / spinner', 'fan', 'low-pressure compressor', 'high-pressure compressor',
      'combustor', 'high-pressure turbine', 'low-pressure turbine', 'shaft', 'nozzle', 'nacelle casing'],
    note: 'Axial machines are a stack of stages on a common shaft inside a casing: air in one end, work taken out at the other. Piston engines are a block, a crank on the centreline, cylinders above it, a head on top and a manifold on the side.'
  },
  {
    id: 'aerospace',
    label: 'wings and airframes',
    re: /\b(wing|airfoil|aerofoil|fuselage|empennage|aileron|elevator|rudder|flap|slat|spar|wing rib|nacelle|pylon|landing gear|undercarriage|rotor blade|propeller|glider|airframe|quadcopter|quadrotor|multirotor|drone|uav|aircraft|aeroplane|airplane|helicopter|stabilis|stabiliz)\w*\b/,
    parts: ['spar', 'ribs', 'leading edge', 'trailing edge', 'upper skin', 'lower skin',
      'aileron', 'flap', 'wing root fairing', 'tip'],
    note: 'A wing is a spar carrying the load, ribs setting the section, and skin closing it. The section is thick at the front and tapers to a fine trailing edge — never a symmetric slab. Control surfaces are cut out of the trailing edge, not stuck onto it.'
  },
  {
    id: 'mechanism',
    label: 'mechanisms and drivetrain',
    re: /\b(gearbox|transmission|differential|gear train|linkage|escapement|clutch|bearing|actuator|governor|cam\b|crank|ratchet|winch|worm drive|planetary|reduction)\b/,
    parts: ['housing', 'input shaft', 'drive gear', 'driven gear', 'idler', 'bearing seats',
      'output shaft', 'cover plate'],
    note: 'A drivetrain is shafts carried in bearings inside a housing, with gears in mesh between them. Gears that mesh sit centre-to-centre at the sum of their radii — they touch, they do not overlap, and they do not float apart.'
  },
  {
    id: 'structure',
    label: 'structures',
    re: /\b(truss|bridge|girder|lattice|gantry|tower|mast|chassis frame|space frame|cantilever|beam|column|arch)\b/,
    parts: ['top chord', 'bottom chord', 'web members', 'gusset plates', 'deck', 'piers', 'bracing'],
    note: 'A truss is two chords held apart by diagonal web members and joined at gussets. Load goes down through triangles; anything that is not triangulated is decoration.'
  },
  {
    id: 'vehicle',
    label: 'vehicles',
    re: /\b(car|automobile|truck|lorry|van|bus|buggy|kart|jeep|wagon|chassis|suspension|axle|bogie|rover|tractor|hull|track(s)?\b|steering|wishbone|subframe|bodyshell|monocoque)\b/,
    parts: ['chassis rails', 'crossmembers', 'axle', 'wheel', 'suspension arm', 'spring', 'body panel'],
    note: 'A chassis is two rails tied by crossmembers, with the axles under it and the body on top. Wheels come in pairs at equal track width.'
  },
  {
    id: 'robotics',
    label: 'robotics',
    re: /\b(robot arm|manipulator|gripper|end effector|servo|joint|gantry|cnc|3d printer|extruder|kinematic)\b/,
    parts: ['base', 'shoulder joint', 'upper arm link', 'elbow joint', 'forearm link', 'wrist', 'gripper jaw', 'servo mount'],
    note: 'A manipulator is links separated by joints, each joint carrying everything outboard of it, so sections taper from a heavy base to a light tool.'
  }
];

/* Which domain a request belongs to, by WEIGHT of evidence rather than by
   which one happens to be first in the list.

   It used to be first-match-wins, and the order of the table was doing the
   deciding: "a car with an engine" met the propulsion vocabulary on
   `engine` before the vehicle vocabulary was ever tried, so the shop went
   looking for jet engines and reasoned about the object as a powerplant.
   The object is a car. Three things decide it now:

     · how much of a domain's vocabulary is present at all
     · how SPECIFIC each hit is — "landing gear" is worth more than "jet",
       because a long term is rarely in a sentence by accident
     · how EARLY it appears, because the thing being asked for is usually
       named before the things it has on it

   Electronics keeps its thumb on the scale, and for the original reason:
   "motor" is propulsion vocabulary, so "a circuit that runs a motor" would
   otherwise be routed to turbofans. The specific reading wins. That is now
   a stated bonus rather than a side effect of list order, which means it
   can be reasoned about instead of being preserved by accident. */
const DOMAIN_BONUS = { electronics: 0.6 };

export function classifyRequest(text) {
  const s = String(text || '').toLowerCase();
  if (!s.trim()) return { domain: 'making', label: 'things people print and build', matched: null, engineering: false };

  let best = null;
  for (const d of DOMAINS) {
    const re = new RegExp(d.re.source, d.re.flags.includes('g') ? d.re.flags : d.re.flags + 'g');
    let score = 0, first = null, hits = 0;
    for (const m of s.matchAll(re)) {
      const term = m[0].trim();
      if (!term) continue;
      hits++;
      /* a two-word term is real evidence; a three-letter one is a coincidence
         waiting to happen */
      const specificity = 0.6 + Math.min(0.8, term.length / 14) + (/\s/.test(term) ? 0.4 : 0);
      const earliness = 1 - Math.min(0.5, m.index / Math.max(12, s.length));
      score += specificity * earliness;
      if (first === null) first = term;
    }
    if (!hits) continue;
    score += DOMAIN_BONUS[d.id] || 0;
    if (!best || score > best.score) best = { d, score, matched: first, hits };
  }

  if (!best) return { domain: 'making', label: 'things people print and build', matched: null, engineering: false };
  return { domain: best.d.id, label: best.d.label, matched: best.matched, engineering: true };
}

export const domainKnowledge = id => DOMAINS.find(d => d.id === id) || null;

/* Which sources to ask, in order. Maker sites still get asked for an
   engineering request — occasionally there IS a good model — but they go
   last and they are not what the prompt leans on. */
/* Every route now ends at the open web, because every route has holes in
   it. Thingiverse has no bandsaw fence, Wikipedia has one paragraph on a
   quadcopter arm, and NTRS has nothing at all about a bike rack — but
   somebody has written a build thread about each of them. */
export function sourcesFor(domain) {
  if (domain === 'making') return ['thingiverse', 'printables', 'web'];
  if (domain === 'aerospace' || domain === 'propulsion') return ['wikipedia', 'ntrs', 'web', 'commons'];
  if (domain === 'electronics') return ['web', 'wikipedia', 'thingiverse'];
  return ['wikipedia', 'web', 'commons', 'thingiverse'];
}

/* Which results are worth the cost of opening. A page fetch is a second
   or two and the planner only has room for a few, so: the open web first
   because a listing there is useless without the page behind it, then
   anything whose summary is too thin to mine. */
export function worthReading(refs, limit = 3) {
  return (refs || [])
    .filter(r => /^https?:\/\//.test(r.url || ''))
    .filter(r => !/\.(pdf|zip|stl|step|dwg|jpe?g|png|gif|mp4)($|\?)/i.test(r.url))
    .map(r => ({ r, score: (r.source === 'web' ? 2 : 0) + (String(r.summary || '').length < 200 ? 1 : 0) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(x => x.r.url);
}

/* ------------------------------------------------------------------ */
/* what to actually search for                                         */
/* ------------------------------------------------------------------ */
const NOISE = /\b(build|make|design|create|model|me|a|an|the|some|please|can|you|with|for|that|has|working|small|big|simple|nice|cool)\b/g;

/* A ladder of queries, most specific first, each one shorter than the last.
   No search index wants the sentence somebody typed: "a desk lamp with a
   folding arm" matches almost nothing on a print site, while "desk lamp"
   matches two thousand things. The caller walks down the ladder until a
   rung actually returns something. */
export function searchTerms(request, domain) {
  const core = String(request || '')
    .toLowerCase()
    .replace(NOISE, ' ')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!core) return [];

  const words = core.split(' ');
  const terms = [core];
  if (words.length > 3) terms.push(words.slice(0, 3).join(' '));
  if (words.length > 2) terms.push(words.slice(0, 2).join(' '));
  // the head noun on its own is the last resort, and for an encyclopedia
  // it is usually the best one: "turbofan", not "turbofan i can see inside"
  if (words.length > 1) terms.push(domainKnowledge(domain) ? words.at(-1) : words.slice(0, 1).join(' '));

  return [...new Set(terms.filter(t => t.length > 2))].slice(0, 4);
}

/* ------------------------------------------------------------------ */
/* is what came back actually about what was asked for                 */
/* ------------------------------------------------------------------ */
/* The reason this exists: an API that ignores an unknown parameter
   returns 200 OK with a page of real, popular, entirely unrelated models,
   and every layer downstream treats that as a good lookup. The prompt then
   tells the planner that people who build desk lamps build tugboats.

   So nothing goes into a prompt without sharing a word with the request.
   Cheap, and it fails safe: a source that breaks in this way now returns
   nothing instead of returning nonsense. */
const REF_STOP = new Set('and or the with for from into 3d print printable model kit remix version'.split(/\s+/));

export function refTokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter(w => w.length > 2 && !REF_STOP.has(w))
    .map(w => (w.endsWith('s') && w.length > 4 ? w.slice(0, -1) : w));
}

/* Words that appear in half the listings on a print site and say nothing
   about what the thing IS. A reference kept because it shares `mount` or
   `v2` with the request is a reference that will mislead the planner and
   the inspector both. */
const WEAK = new Set(('mount holder stand bracket case cover box adapter insert clip hook plate'
  + ' remix improved easy quick print printable printed parametric customizable customisable'
  + ' version model kit set piece part tool jig test sample demo replacement spare').split(/\s+/));

/* The thing being asked for, as opposed to the things it has on it. Same
   rule as skills.js headNoun and deliberately a second copy: both files
   import nothing, so neither can reach the other's. wiring.test.mjs checks
   the two agree, the same way it checks the two lists of primitives. */
export function headTerm(text) {
  const words = String(text || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/);
  const cut = words.findIndex(w => ['with', 'for', 'that', 'which', 'holding', 'carrying', 'on', 'to'].includes(w));
  const head = (cut > 0 ? words.slice(0, cut) : words).filter(w => w.length > 2 && !REF_STOP.has(w));
  const last = head[head.length - 1] || '';
  return last.endsWith('s') && last.length > 4 ? last.slice(0, -1) : last;
}

/* How much a reference has to do with what was asked for.

   This used to count shared tokens and keep anything above zero, which is
   how "Model Rocket Engine Holder" survived a request for a car with an
   engine: one word in common, and from there it goes into the planning
   prompt AND the critique prompt as an example of the thing being built.
   One shared word is a coincidence. What counts now is WHICH word:

     the head noun   what the request is actually about        1.0
     another term    corroboration                             0.45
     a weak word     `mount`, `remix`, `v2` — nothing at all    0

   so a reference has to name the object, or match two real words that are
   not the object, before it is worth showing anybody. */
export function relevanceOf(ref, terms, head = '') {
  const want = new Set((terms || []).flatMap(refTokens));
  if (!want.size) return 1;
  const hay = new Set(refTokens(
    [ref.title, (ref.tags || []).join(' '), ref.summary].filter(Boolean).join(' ')
  ));
  const h = String(head || '').toLowerCase();
  let score = 0;
  for (const w of want) {
    if (!hay.has(w)) continue;
    if (w === h) score += 1;
    else if (WEAK.has(w)) continue;
    else score += 0.45;
  }
  /* A title that names the object outright beats one that merely mentions
     it in a description somewhere. */
  if (h && refTokens(ref.title).includes(h)) score += 0.35;
  return score;
}

export const RELEVANCE_FLOOR = 0.9;

/* Drop anything that shares no word with the request, and put whatever
   matched most at the top — that is the one the prompt has room for. */
/* `request` is optional so an old call site still works, but passing it is
   what lets the ranking know which word is the object rather than treating
   every search term as equally telling. */
export function rankRefs(refs, terms, request = '') {
  /* The head noun comes from the REQUEST and nowhere else. Deriving it
     from a search term looks like it works and does not: terms are keyword
     bags, so "desk lamp folding arm" hands back `arm` and the ranking then
     believes the request was about an arm. With no request there is no
     head, and a reference has to earn its place on corroboration alone. */
  const head = request ? headTerm(request) : '';
  return (refs || [])
    .map(r => ({ r, score: relevanceOf(r, terms, head) }))
    .filter(x => x.score >= RELEVANCE_FLOOR)
    .sort((a, b) => (b.score - a.score) || ((b.r.likes || 0) - (a.r.likes || 0)))
    .map(x => x.r);
}

/* ------------------------------------------------------------------ */
/* pulling structure out of prose                                      */
/* ------------------------------------------------------------------ */
/* An encyclopedia paragraph is not a parts list, but it contains one:
   "consists of a fan, a compressor, a combustor and a turbine". This
   finds those enumerations and turns them into the vocabulary the planner
   should be using. Deliberately conservative — a wrong part name is worse
   than no part name, because the model will build it. */
const LEAD = /\b(?:consists? of|comprises?|composed of|made up of|components?(?: are| include)?|parts?(?: are| include)|contains?|includes?)\b([^.;]{10,240})/gi;

export function structureFrom(text) {
  const src = String(text || '').replace(/\([^)]*\)/g, ' ');
  const found = [];

  for (const m of src.matchAll(LEAD)) {
    for (const raw of m[1].split(/,| and | as well as /i)) {
      const t = raw
        .replace(/^\s*(?:a|an|the|its|their|several|two|three|four|multiple|one)\s+/i, '')
        .replace(/[^A-Za-z0-9 \-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      // a part name is one to three words; anything longer is a clause
      if (t.length < 3 || t.length > 34) continue;
      if (t.split(' ').length > 3) continue;
      if (/\b(which|that|are|is|was|were|used|using|often|usually|typically|may|can)\b/.test(t)) continue;
      found.push(t);
    }
  }
  return [...new Set(found)].slice(0, 12);
}

/* ------------------------------------------------------------------ */
/* the prompt block                                                    */
/* ------------------------------------------------------------------ */
/* Different wording from the maker block on purpose. A published print is
   evidence of what people build; an encyclopedia article is evidence of
   what the thing IS, and the planner should be taking structure from it
   rather than trying to imitate a photograph. */
export function technicalBlock(request, refs, domain) {
  const k = domainKnowledge(domain);
  if (!k && !refs?.length) return '';

  const cited = (refs || []).filter(r => SOURCES[r.source]?.kind === 'engineering').slice(0, 6);
  const observed = [...new Set(cited.flatMap(r => r.structure || []))].slice(0, 14);
  const vocabulary = [...new Set([...(k?.parts || []), ...observed])].slice(0, 16);

  const lines = cited.map(r => {
    const st = r.structure?.length ? `\n      parts named: ${r.structure.slice(0, 8).join(', ')}` : '';
    const sum = r.summary ? `\n      "${String(r.summary).slice(0, 200)}"` : '';
    return `  · ${r.title}   [${SOURCES[r.source]?.label || r.source}]${st}${sum}`;
  }).join('\n');

  return `
WHAT THE REAL THING IS MADE OF
This is an engineering object${k ? ` — ${k.label}` : ''}, not something with a
good printable model behind it. What follows is how one is actually put
together.
${k ? `\n${k.note}\n` : ''}
Use these part names. They are what the parts are called:
  ${vocabulary.join(', ')}
${lines ? `\nRead from:\n${lines}\n` : ''}
Build the STRUCTURE, in the shop's own vocabulary: a stack of stages is a
run of cylinders on a shaft, a casing is a tube around them, a section that
tapers is a cone. Give every major assembly its own part with the name
above, get the proportions and the order along the axis right, and let the
arrays do the repeated ones — a compressor is one disc with an array, not
one disc. Do not invent parts that are not on that list unless the request
asked for them, and do not mention any of this in a "say" line.
`;
}

/* ------------------------------------------------------------------ */
/* building one with no engine at all                                  */
/* ------------------------------------------------------------------ */
/* The keyword planner knows about lamps and shelves. Ask it for a
   turbofan with the network down and it produces a generic box stack,
   which is the one case where the offline fallback was genuinely useless.

   This turns a domain vocabulary into real part specs. It is not a design
   — it is the right parts, in the right order along the axis, in roughly
   the right proportions, which is a great deal closer to an engine than
   three boxes are. Names drive the shape: anything called a casing is a
   tube around the outside, a disc-like stage is a wide flat cylinder, a
   shaft is a rod, and anything that leads or trails is a cone. */
const SHAPE_RULES = [
  [/casing|nacelle|housing|cowl|shroud/, { shape: 'cylinder', size: [0.86, 0.30, 0.86] }],
  [/skin|panel|plate|deck|gusset|cover/, { shape: 'panel', size: [0.90, 0.06, 0.60] }],
  [/nozzle|inlet|spinner|nose|tip|leading edge/, { shape: 'cone', size: [0.44, 0.30, 0.44] }],
  [/shaft|spar|rail|chord|mast|boom|column/, { shape: 'rod', size: [0.16, 1.10, 0.16] }],
  [/fan|compressor|turbine|disc|rotor|impeller|flywheel/, { shape: 'gear', size: [0.62, 0.10, 0.62] }],
  [/combustor|chamber|duct|manifold|tube|bearing/, { shape: 'cylinder', size: [0.52, 0.26, 0.52] }],
  [/gear|pinion|wheel/, { shape: 'gear', size: [0.40, 0.09, 0.40] }],
  [/rib|web member|bracing|strut|linkage/, { shape: 'panel', size: [0.34, 0.30, 0.05], array: { mode: 'row', count: 4, spacing: 0.24 } }],
  [/blade|aileron|flap|rudder|elevator|trailing edge/, { shape: 'panel', size: [0.46, 0.05, 0.26] }],
  [/joint|jaw|arm|link/, { shape: 'box', size: [0.30, 0.34, 0.24] }]
];

export function domainParts(domain, material = 'metal') {
  const k = domainKnowledge(domain);
  if (!k) return null;

  return k.parts.slice(0, 8).map((role, i) => {
    const rule = (SHAPE_RULES.find(([re]) => re.test(role)) || [null, { shape: 'box', size: [0.5, 0.3, 0.5] }])[1];
    const part = {
      name: role.replace(/\s*\/\s*/g, ' '),
      shape: rule.shape,
      material,
      size: rule.size.slice(),
      ...(rule.array ? { array: { ...rule.array } } : {})
    };
    // a stack on a common axis: everything sits on the one before it, which
    // is what an axial machine and a wing box both actually are
    if (i > 0) part.attach = { to: i - 1, face: 'top' };
    return part;
  });
}

/* ------------------------------------------------------------------ */
/* what a page is actually worth                                       */
/* ------------------------------------------------------------------ */
/* This is the part that answers the complaint. A model asked for "a
   bandsaw fence" has read a lot of text about bandsaws and remembers
   none of it precisely, so it invents a plausible slab. The build thread
   somebody wrote says the fence is a hardwood face on an aluminium
   extrusion with a cam clamp at each end, and that it is 24 inches long
   and 4 inches tall.

   Those two facts — the PART NAMES and the DIMENSIONS people actually
   quote — are what the planner cannot guess and what a search-result
   title cannot carry. Everything below exists to get them out of raw
   page text and into the prompt, and to leave the rest of the page,
   which is navigation and comments and cookie banners, on the floor. */

/* Nouns that mean "this is a page about making the thing" rather than a
   shop listing or a news article. */
const BUILD_SIGNAL = /\b(cut|drill|weld|glue|screw|bolt|assemble|attach|mount|clamp|thickness|diameter|length|width|material|plywood|aluminium|aluminum|steel|printed|tolerance|dimension)\b/gi;

export function pageValue(text) {
  const s = String(text || '');
  if (s.length < 400) return 0;
  const hits = (s.match(BUILD_SIGNAL) || []).length;
  // per thousand characters, so a long page of comments does not beat a
  // short page of instructions
  return hits / Math.max(1, s.length / 1000);
}

/* Dimensions, as people write them. A build thread says "3/4 inch ply",
   "24in long", "200 x 100 x 3mm", "M6 bolt" — all of which are worth more
   to the planner than anything it would invent. Everything is normalised
   to millimetres so the sizes it produces are in the same world as the
   ones the shop uses. */
const DIM_RE = /(\d+(?:\.\d+)?)\s*(?:\/\s*(\d+))?\s*(mm|cm|m\b|in\b|inch(?:es)?|"|thou)/gi;

export function dimensionsFrom(text) {
  const out = [];
  const seen = new Set();
  let m;
  const re = new RegExp(DIM_RE.source, 'gi');
  while ((m = re.exec(String(text || ''))) && out.length < 12) {
    let v = Number(m[1]);
    if (m[2]) v = v / Number(m[2]);            // "3/4 inch"
    if (!Number.isFinite(v) || v <= 0) continue;
    const unit = m[3].toLowerCase();
    const mm = unit === 'mm' ? v
      : unit === 'cm' ? v * 10
        : unit === 'm' ? v * 1000
          : unit === 'thou' ? v * 0.0254
            : v * 25.4;                        // in, inch, inches, "
    // anything smaller than a screw thread or bigger than a room is not a
    // dimension of the thing being built
    if (mm < 1 || mm > 6000) continue;
    const k = Math.round(mm);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ mm: k, as: m[0].trim() });
  }
  return out.sort((a, b) => b.mm - a.mm).slice(0, 8);
}

/* Read the pages that came back and turn them into the two things worth
   having. `pages` is [{ url, text }] straight from main — this side never
   fetches anything. */
export function minePages(pages, refs) {
  const byUrl = new Map((refs || []).map(r => [r.url, r]));
  const read = [];

  for (const p of pages || []) {
    const value = pageValue(p.text);
    if (value < 1.2) continue;                 // a page that never mentions making anything
    const structure = structureFrom(p.text);
    const dims = dimensionsFrom(p.text);
    if (!structure.length && !dims.length) continue;
    read.push({
      url: p.url,
      title: byUrl.get(p.url)?.title || p.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60),
      value: Math.round(value * 10) / 10,
      structure,
      dimensions: dims,
      // the sentence that names the most parts is usually the one that
      // describes the object, and it is worth quoting verbatim
      line: bestLine(p.text)
    });
  }
  return read.sort((a, b) => b.value - a.value).slice(0, 4);
}

/* The single most informative sentence on the page: the one naming the
   most parts, preferring one that also carries a number. */
function bestLine(text) {
  const lines = String(text || '').split(/(?<=[.!?])\s+|\n/).map(l => l.trim())
    .filter(l => l.length > 40 && l.length < 260);
  let best = '', score = -1;
  for (const l of lines.slice(0, 400)) {
    const parts = (l.match(BUILD_SIGNAL) || []).length;
    const nums = /\d/.test(l) ? 1 : 0;
    const s = parts * 2 + nums;
    if (s > score) { score = s; best = l; }
  }
  return score > 2 ? best : '';
}

/* What the read pages contribute to the prompt. Deliberately separate
   from technicalBlock: that block is what the SHOP knows about a domain,
   this one is what somebody who has built the thing wrote down, and the
   planner should be able to tell them apart. */
export function readingBlock(read) {
  if (!read?.length) return '';
  const lines = read.map(r => {
    const bits = [`  · ${r.title}`];
    if (r.structure.length) bits.push(`      parts named: ${r.structure.slice(0, 8).join(', ')}`);
    if (r.dimensions.length) bits.push(`      sizes quoted: ${r.dimensions.slice(0, 5).map(d => `${d.mm}mm (${d.as})`).join(', ')}`);
    if (r.line) bits.push(`      "${r.line.slice(0, 180)}"`);
    return bits.join('\n');
  }).join('\n');

  return `
WHAT SOMEBODY WHO HAS BUILT ONE WROTE DOWN
These pages were opened and read just now, not just listed. The part names
below are the words people who make this thing actually use, and the sizes
are the ones they actually quote — both are worth more than a guess.

${lines}

Use the part names. Use the proportions the sizes imply — if a page says a
part is 600mm long and 40mm thick, yours should be long and thin in the
same ratio, whatever absolute size you end up choosing. This is reference,
not instruction: what was asked for still wins where the two disagree.`;
}

/* Main hands back prose; the parts list has to be mined out of it here,
   because extraction is string work and string work belongs where it can
   be tested. */
export function enrichRefs(refs) {
  return (refs || []).map(r => {
    if (SOURCES[r.source]?.kind !== 'engineering') return r;
    return { ...r, structure: structureFrom(r.summary), summary: trimProse(r.summary) };
  });
}

/* An encyclopedia extract runs to two thousand characters of history and
   variants. The planner needs the first paragraph, which is the one that
   says what the thing is. */
function trimProse(text) {
  const s = String(text || '').trim();
  if (s.length <= 320) return s;
  const cut = s.slice(0, 320);
  const stop = cut.lastIndexOf('. ');
  return (stop > 120 ? cut.slice(0, stop + 1) : cut) + '…';
}

/* Two sources returning the same design should not take up two of the ten
   slots the prompt has room for. */
export function mergeRefs(lists, limit = 12) {
  const seen = new Set();
  const out = [];
  for (const list of lists || []) {
    for (const r of list || []) {
      if (!r || !r.title) continue;
      const key = String(r.title).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(r);
      if (out.length >= limit) return out;
    }
  }
  return out;
}
