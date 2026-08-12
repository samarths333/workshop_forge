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
  openverse:   { label: 'Openverse',   kind: 'engineering', note: 'openly licensed diagrams' }
};

/* ------------------------------------------------------------------ */
/* what kind of thing is this                                          */
/* ------------------------------------------------------------------ */
/* Ordered: the first domain that matches wins, so the specific patterns
   come before the general ones. "rocket engine" is propulsion, not a
   rocket; "landing gear" is aerospace, not a mechanism. */
const DOMAINS = [
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
    re: /\b(wing|airfoil|aerofoil|fuselage|empennage|aileron|elevator|rudder|flap|slat|spar|wing rib|nacelle|pylon|landing gear|undercarriage|rotor blade|propeller|glider|airframe|stabilis|stabiliz)\w*\b/,
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
    re: /\b(chassis|suspension|axle|bogie|rover|tractor|hull|track(s)?\b|steering|wishbone|subframe)\b/,
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

export function classifyRequest(text) {
  const s = String(text || '').toLowerCase();
  for (const d of DOMAINS) {
    const hit = s.match(d.re);
    if (hit) return { domain: d.id, label: d.label, matched: hit[0].trim(), engineering: true };
  }
  return { domain: 'making', label: 'things people print and build', matched: null, engineering: false };
}

export const domainKnowledge = id => DOMAINS.find(d => d.id === id) || null;

/* Which sources to ask, in order. Maker sites still get asked for an
   engineering request — occasionally there IS a good model — but they go
   last and they are not what the prompt leans on. */
export function sourcesFor(domain) {
  if (domain === 'making') return ['thingiverse', 'printables'];
  if (domain === 'aerospace' || domain === 'propulsion') return ['wikipedia', 'commons', 'ntrs', 'thingiverse'];
  return ['wikipedia', 'commons', 'openverse', 'thingiverse'];
}

/* ------------------------------------------------------------------ */
/* what to actually search for                                         */
/* ------------------------------------------------------------------ */
const NOISE = /\b(build|make|design|create|model|me|a|an|the|some|please|can|you|with|for|that|has|working|small|big|simple|nice|cool)\b/g;

export function searchTerms(request, domain) {
  const core = String(request || '')
    .toLowerCase()
    .replace(NOISE, ' ')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const terms = [core].filter(Boolean);
  const k = domainKnowledge(domain);
  // an encyclopedia wants the thing's name, not the sentence it was asked
  // for in — "turbofan engine" finds an article, "a turbofan with fan
  // blades i can see" finds nothing
  if (k && core) {
    const head = core.split(' ').slice(0, 3).join(' ');
    if (head !== core) terms.push(head);
  }
  return [...new Set(terms)].slice(0, 3);
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
