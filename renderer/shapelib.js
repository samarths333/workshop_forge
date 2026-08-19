/* =====================================================================
   THE SHAPE VOCABULARY — as data.

   Nine shapes used to be nine arms of a switch in shapes.js, which meant a
   tenth was a code change and a shape somebody wanted was a shape they
   could not have. Everything else in this app that grew past a handful
   became a table — the engines, the crew, the command surface — and this
   is the same move for the same reason.

   A shape is a PROFILE plus a rule for sweeping it. Two rules cover almost
   everything a shop makes:

     revolve   a half-section spun about +Y. Cone, dome, bowl, barrel,
               vase, funnel, spool, knob, bottle, tube — anything that came
               off a lathe, which is most round things.
     extrude   an outline pushed along +Z, with holes. Angle, channel,
               I-beam, tee, star, arch, arrow — anything that came out of a
               die or off a bandsaw, which is most flat things.

   THE ONE RULE THAT MAKES THIS SAFE: every profile is authored in a unit
   box and the finished mesh is normalised to fill exactly [w, h, d]. So
   `effectiveSize` for any shape defined here is the size it was asked for,
   with nothing to keep in sync — the drift that geometry.test.mjs exists
   to catch cannot happen for a shape nobody wrote code for. It is the same
   trade as the solver's: give up a little control over the exact section
   and get an invariant that holds for shapes that do not exist yet.

   Imports nothing. The profile arithmetic, the validation and the registry
   are all checkable in node, and shapes.js is the only thing here that
   knows what three.js is.
   ===================================================================== */

export const SHAPE_KINDS = ['revolve', 'extrude'];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

/* Authoring helpers. A revolve profile is [radius, height] pairs, both
   0..1: radius is a fraction of the half-width, height runs bottom to top.
   An extrude outline is [x, y] pairs, both 0..1, from the bottom-left. */
const R = (...pairs) => pairs;

/* ------------------------------------------------------------------ */
/* the built-in library                                                */
/* ------------------------------------------------------------------ */
/* These are the shapes the shop ships with beyond the original nine. Each
   is a row, and adding one is adding a row — which is the whole point.
   `words` is what somebody would call it when asking for one; the planner
   sees them and so does the shape picker's search. */
export const BUILTIN_SHAPES = [
  /* ---- turned things ------------------------------------------- */
  {
    id: 'dome', label: 'Dome', kind: 'revolve', group: 'turned',
    words: ['dome', 'hemisphere', 'cap', 'canopy', 'bubble'],
    note: 'half a sphere, flat side down',
    profile: R([1, 0], [0.99, 0.06], [0.92, 0.28], [0.78, 0.5], [0.56, 0.7], [0.3, 0.88], [0, 1])
  },
  {
    id: 'bowl', label: 'Bowl', kind: 'revolve', group: 'turned',
    words: ['bowl', 'dish', 'cup', 'basin', 'hopper'],
    note: 'open at the top, with a wall',
    profile: R([0, 0], [0.5, 0], [0.62, 0.12], [0.8, 0.45], [0.95, 0.8], [1, 1],
      [0.88, 1], [0.84, 0.8], [0.68, 0.45], [0.5, 0.14], [0.34, 0.1], [0, 0.1])
  },
  {
    id: 'barrel', label: 'Barrel', kind: 'revolve', group: 'turned',
    words: ['barrel', 'drum', 'keg', 'cask', 'tank'],
    note: 'a cylinder with a belly',
    profile: R([0, 0], [0.82, 0], [0.86, 0.08], [0.98, 0.3], [1, 0.5], [0.98, 0.7], [0.86, 0.92], [0.82, 1], [0, 1])
  },
  {
    id: 'vase', label: 'Vase', kind: 'revolve', group: 'turned',
    words: ['vase', 'urn', 'pot', 'flask', 'jar'],
    note: 'a wide body drawn into a neck',
    profile: R([0, 0], [0.52, 0], [0.6, 0.06], [0.88, 0.22], [1, 0.42], [0.86, 0.62], [0.52, 0.8], [0.42, 0.9], [0.46, 1], [0, 1])
  },
  {
    id: 'funnel', label: 'Funnel', kind: 'revolve', group: 'turned',
    words: ['funnel', 'hopper', 'nozzle', 'horn', 'intake', 'bell'],
    note: 'a wide mouth necking down to a spout',
    profile: R([0, 0], [0.18, 0], [0.18, 0.4], [0.34, 0.58], [0.68, 0.8], [1, 1], [0, 1])
  },
  {
    id: 'spool', label: 'Spool', kind: 'revolve', group: 'turned',
    words: ['spool', 'pulley', 'reel', 'sheave', 'bobbin', 'roller'],
    note: 'a waisted roller with a flange each end',
    profile: R([0, 0], [1, 0], [1, 0.14], [0.56, 0.24], [0.56, 0.76], [1, 0.86], [1, 1], [0, 1])
  },
  {
    id: 'knob', label: 'Knob', kind: 'revolve', group: 'turned',
    words: ['knob', 'handle', 'dial', 'grip', 'finial', 'cap'],
    note: 'a turned handle with a collar',
    profile: R([0, 0], [0.46, 0], [0.46, 0.16], [0.72, 0.22], [1, 0.4], [0.98, 0.72], [0.74, 0.92], [0.4, 1], [0, 1])
  },
  {
    id: 'bottle', label: 'Bottle', kind: 'revolve', group: 'turned',
    words: ['bottle', 'cylinderbottle', 'canister', 'tank', 'gas', 'cartridge'],
    note: 'a straight body with a shoulder and a neck',
    profile: R([0, 0], [0.94, 0], [1, 0.05], [1, 0.6], [0.94, 0.72], [0.6, 0.82], [0.36, 0.88], [0.36, 1], [0, 1])
  },
  {
    /* Called `pipe` and not `tube` because `tube` was already an alias for
       a solid cylinder in partGeometry, and a definition whose id collides
       with an alias is silently never reached — it draws the old shape and
       looks like the profile is wrong. */
    id: 'pipe', label: 'Pipe', kind: 'revolve', group: 'turned',
    words: ['pipe', 'tube', 'sleeve', 'bush', 'bushing', 'collar', 'hollow', 'bore'],
    note: 'a tube with a real bore through it',
    profile: R([0.62, 0], [1, 0], [1, 1], [0.62, 1], [0.62, 0])
  },
  {
    id: 'washer', label: 'Washer', kind: 'revolve', group: 'turned',
    words: ['washer', 'shim', 'flange', 'annulus', 'gasket', 'seal'],
    note: 'a flat ring — a tube with almost no length',
    profile: R([0.45, 0], [1, 0], [1, 1], [0.45, 1], [0.45, 0])
  },
  {
    id: 'capsule', label: 'Capsule', kind: 'revolve', group: 'turned',
    words: ['capsule', 'pill', 'rounded', 'bullet', 'slug', 'tanklike'],
    note: 'a cylinder with domed ends',
    profile: R([0, 0], [0.55, 0.02], [0.85, 0.07], [1, 0.16], [1, 0.84], [0.85, 0.93], [0.55, 0.98], [0, 1])
  },
  {
    id: 'nosecone', label: 'Nose cone', kind: 'revolve', group: 'turned',
    words: ['nosecone', 'nose', 'ogive', 'tip', 'spike', 'spinner'],
    note: 'an ogive, not a straight cone — what a nose actually is',
    profile: R([0, 0], [1, 0], [0.97, 0.2], [0.88, 0.42], [0.72, 0.62], [0.48, 0.82], [0.2, 0.95], [0, 1])
  },

  /* ---- sawn and rolled things ----------------------------------- */
  {
    id: 'hex', label: 'Hex bar', kind: 'extrude', group: 'section',
    words: ['hex', 'hexagon', 'hexagonal', 'nut', 'sixsided', 'bar'],
    note: 'six-sided stock, standing on a flat',
    outline: [[0.25, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0.25, 1], [0, 0.5]]
  },
  {
    id: 'angle', label: 'Angle', kind: 'extrude', group: 'section',
    words: ['angle', 'lbracket', 'lsection', 'corner', 'iron', 'bracket'],
    note: 'L-section — the workhorse of anything welded',
    outline: [[0, 0], [1, 0], [1, 0.22], [0.22, 0.22], [0.22, 1], [0, 1]]
  },
  {
    id: 'channel', label: 'Channel', kind: 'extrude', group: 'section',
    words: ['channel', 'usection', 'uchannel', 'trough', 'rail', 'track'],
    note: 'U-section, open at the top',
    outline: [[0, 0], [1, 0], [1, 1], [0.78, 1], [0.78, 0.2], [0.22, 0.2], [0.22, 1], [0, 1]]
  },
  {
    id: 'ibeam', label: 'I-beam', kind: 'extrude', group: 'section',
    words: ['ibeam', 'beam', 'girder', 'joist', 'hsection', 'rsj'],
    note: 'the section that carries a floor',
    outline: [[0, 0], [1, 0], [1, 0.18], [0.64, 0.24], [0.64, 0.76], [1, 0.82], [1, 1], [0, 1],
      [0, 0.82], [0.36, 0.76], [0.36, 0.24], [0, 0.18]]
  },
  {
    id: 'tee', label: 'Tee', kind: 'extrude', group: 'section',
    words: ['tee', 'tsection', 'tbar', 'tjoint', 'stanchion'],
    note: 'T-section',
    outline: [[0, 0.78], [0.36, 0.78], [0.36, 0], [0.64, 0], [0.64, 0.78], [1, 0.78], [1, 1], [0, 1]]
  },
  {
    id: 'cross', label: 'Cross', kind: 'extrude', group: 'section',
    words: ['cross', 'plus', 'crossbrace', 'spider', 'x', 'junction'],
    note: 'a four-way junction plate',
    outline: [[0.34, 0], [0.66, 0], [0.66, 0.34], [1, 0.34], [1, 0.66], [0.66, 0.66],
      [0.66, 1], [0.34, 1], [0.34, 0.66], [0, 0.66], [0, 0.34], [0.34, 0.34]]
  },
  {
    id: 'star', label: 'Star', kind: 'extrude', group: 'plate',
    words: ['star', 'spike', 'burst', 'cog', 'sprocket', 'rosette'],
    note: 'a six-pointed plate',
    outline: starOutline(6, 0.5, 0.22)
  },
  {
    id: 'arch', label: 'Arch', kind: 'extrude', group: 'plate',
    words: ['arch', 'archway', 'gate', 'doorway', 'portal', 'bridge', 'hoop'],
    note: 'two legs and a round head',
    outline: archOutline()
  },
  {
    id: 'arrow', label: 'Arrow', kind: 'extrude', group: 'plate',
    words: ['arrow', 'pointer', 'marker', 'sign', 'chevron', 'dart'],
    note: 'a pointer, for signs and markers',
    outline: [[0.3, 0], [0.7, 0], [0.7, 0.55], [1, 0.55], [0.5, 1], [0, 0.55], [0.3, 0.55]]
  },
  {
    id: 'bracket', label: 'Gusset', kind: 'extrude', group: 'plate',
    words: ['gusset', 'bracket', 'brace', 'knee', 'triangle', 'support', 'shelf'],
    note: 'a braced corner with the waste cut out',
    outline: [[0, 0], [1, 0], [1, 0.2], [0.34, 0.2], [0.2, 0.34], [0.2, 1], [0, 1]]
  },
  {
    id: 'trapezoid', label: 'Trapezoid', kind: 'extrude', group: 'plate',
    words: ['trapezoid', 'taper', 'tapered', 'keystone', 'flare', 'skirt'],
    note: 'a tapered slab — wide at the bottom',
    outline: [[0, 0], [1, 0], [0.78, 1], [0.22, 1]]
  },
  {
    id: 'ring_plate', label: 'Ring plate', kind: 'extrude', group: 'plate',
    words: ['ringplate', 'flange', 'disc', 'hoop', 'annulus', 'bearing', 'hole'],
    note: 'a disc with a bore — a flange, laid flat by rotation',
    outline: circleOutline(1, 32),
    holes: [circleOutline(0.42, 24)]
  },
  {
    id: 'slot_plate', label: 'Slotted plate', kind: 'extrude', group: 'plate',
    words: ['slotted', 'slot', 'perforated', 'plate', 'mount', 'adjustable'],
    note: 'a mounting plate with a slot to adjust on',
    outline: [[0, 0], [1, 0], [1, 1], [0, 1]],
    holes: [[[0.18, 0.34], [0.82, 0.34], [0.82, 0.66], [0.18, 0.66]]]
  }
];

/* Two outlines that are easier to compute than to type. Both authored in
   the same 0..1 box as everything else. */
function starOutline(points, outer, inner) {
  const pts = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 ? inner : outer;
    const t = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
    pts.push([0.5 + Math.cos(t) * r, 0.5 + Math.sin(t) * r]);
  }
  return pts;
}

function circleOutline(diameter, steps) {
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    pts.push([0.5 + Math.cos(t) * diameter / 2, 0.5 + Math.sin(t) * diameter / 2]);
  }
  return pts;
}

function archOutline() {
  const pts = [[0, 0], [0.22, 0], [0.22, 0.55]];
  for (let i = 0; i <= 12; i++) {                    // the inner soffit
    const t = Math.PI - (i / 12) * Math.PI;
    pts.push([0.5 + Math.cos(t) * 0.28, 0.55 + Math.sin(t) * 0.28]);
  }
  pts.push([0.78, 0], [1, 0], [1, 0.55]);
  for (let i = 0; i <= 14; i++) {                    // and the extrados
    const t = (i / 14) * Math.PI;
    pts.push([0.5 + Math.cos(t) * 0.5, 0.55 + Math.sin(t) * 0.5]);
  }
  return pts;
}

/* ------------------------------------------------------------------ */
/* validation — a shape off disk is as untrusted as a plan off a model */
/* ------------------------------------------------------------------ */
/* Same job `skills.sanitize` does for the skill file and for the same
   reason: shapes.json is a user-editable file that comes back off disk,
   and a profile with a NaN in it draws a mesh full of NaN vertices that
   renders as nothing at all with no error anywhere. */
export const SHAPE_ID_RE = /^[a-z][a-z0-9_]{1,31}$/;

const POINT_MIN = 3, POINT_MAX = 96, HOLE_MAX = 4;

function cleanPoints(list, min) {
  if (!Array.isArray(list)) return null;
  const pts = list
    .map(p => (Array.isArray(p) ? [num(p[0]), num(p[1])] : null))
    .filter(p => p && Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .slice(0, POINT_MAX)
    .map(p => [clamp(p[0], -4, 4), clamp(p[1], -4, 4)]);
  return pts.length >= min ? pts : null;
}

/* A profile that is flat in one direction sweeps nothing: a revolve whose
   radii are all zero is a line, an outline with no area is a crease. Both
   draw without complaint and both are invisible, so they are rejected
   here rather than discovered on the pedestal. */
function spans(pts, axis) {
  let lo = Infinity, hi = -Infinity;
  for (const p of pts) { lo = Math.min(lo, p[axis]); hi = Math.max(hi, p[axis]); }
  return hi - lo;
}

export function validateShapeDef(raw, { custom = true } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (!SHAPE_ID_RE.test(id)) return null;
  const kind = SHAPE_KINDS.includes(raw.kind) ? raw.kind : 'extrude';

  const def = {
    id,
    label: String(raw.label || id).slice(0, 40) || id,
    kind,
    group: String(raw.group || (kind === 'revolve' ? 'turned' : 'plate')).slice(0, 20),
    note: String(raw.note || '').slice(0, 120),
    words: Array.isArray(raw.words)
      ? [...new Set(raw.words.map(w => String(w).toLowerCase().replace(/[^a-z0-9]/g, '')).filter(Boolean))].slice(0, 12)
      : [],
    custom: !!custom
  };
  if (!def.words.includes(id)) def.words.unshift(id);

  if (kind === 'revolve') {
    const profile = cleanPoints(raw.profile, POINT_MIN);
    if (!profile) return null;
    if (spans(profile, 1) < 0.02) return null;         // no height: a disc of nothing
    if (Math.max(...profile.map(p => Math.abs(p[0]))) < 0.02) return null;   // no radius: a line
    def.profile = profile;
    def.segments = clamp(Math.round(num(raw.segments, 28)), 6, 64);
  } else {
    const outline = cleanPoints(raw.outline, POINT_MIN);
    if (!outline) return null;
    if (spans(outline, 0) < 0.02 || spans(outline, 1) < 0.02) return null;   // no area
    def.outline = outline;
    const holes = Array.isArray(raw.holes)
      ? raw.holes.map(h => cleanPoints(h, POINT_MIN)).filter(Boolean).slice(0, HOLE_MAX)
      : [];
    if (holes.length) def.holes = holes;
  }
  return def;
}

/* The whole file, as it comes off disk. Anything that will not validate is
   dropped rather than throwing — one bad shape must not cost somebody the
   other nine. */
export function sanitizeLibrary(raw) {
  const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.shapes) ? raw.shapes : []);
  const out = [];
  const seen = new Set(BUILTIN_SHAPES.map(s => s.id));
  for (const item of list) {
    const def = validateShapeDef(item, { custom: true });
    if (!def || seen.has(def.id)) continue;            // never shadow a built-in
    seen.add(def.id);
    out.push(def);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* the registry                                                        */
/* ------------------------------------------------------------------ */
/* The live list is BUILT-IN plus whatever the person has made. It has to
   be live rather than computed once, because a shape saved at four in the
   afternoon has to be in the planner's enum at four-oh-one without a
   restart — so `SHAPE_ENUM` is one array that is mutated in place and
   every schema that referenced it stays correct. Handing out a fresh array
   instead is how half the app ends up holding yesterday's vocabulary. */
const custom = new Map();

/* The nine the solver has always known about, and which have their own
   `effectiveSize` rules in assembly.js. Everything defined here falls
   through to the default arm, which is exactly why every mesh built from
   a definition is normalised to the size it was asked for. */
export const PRIMITIVE_SHAPES = ['box', 'panel', 'cylinder', 'rod', 'cone', 'sphere', 'torus', 'wedge', 'gear'];

export const SHAPE_ENUM = [];

function rebuildEnum() {
  SHAPE_ENUM.length = 0;
  SHAPE_ENUM.push(...PRIMITIVE_SHAPES, ...BUILTIN_SHAPES.map(s => s.id), ...custom.keys());
}
rebuildEnum();

export function registerShapes(defs) {
  custom.clear();
  for (const def of sanitizeLibrary(defs)) custom.set(def.id, def);
  rebuildEnum();
  return [...custom.values()];
}

export function customShapes() { return [...custom.values()]; }

export function allShapes() {
  return [
    ...PRIMITIVE_SHAPES.map(id => ({ id, label: primitiveLabel(id), kind: 'primitive', group: 'primitive', words: [id], custom: false })),
    ...BUILTIN_SHAPES.map(s => ({ ...s, custom: false })),
    ...custom.values()
  ];
}

export function shapeIds() { return [...SHAPE_ENUM]; }

export function isShape(id) { return SHAPE_ENUM.includes(String(id || '').toLowerCase()); }

/* The definition behind an id, or null for one of the nine primitives —
   those are drawn by hand in shapes.js and always will be, because a
   chamfered box and a torus laid flat are opinions, not profiles. */
export function shapeDef(id) {
  const key = String(id || '').toLowerCase();
  if (custom.has(key)) return custom.get(key);
  return BUILTIN_SHAPES.find(s => s.id === key) || null;
}

function primitiveLabel(id) {
  return { box: 'Box', panel: 'Panel', cylinder: 'Cylinder', rod: 'Rod', cone: 'Cone',
    sphere: 'Sphere', torus: 'Torus', wedge: 'Wedge', gear: 'Gear' }[id] || id;
}

/* ------------------------------------------------------------------ */
/* the geometry, as numbers                                            */
/* ------------------------------------------------------------------ */
/* shapes.js turns these into three.js. Kept here so the point maths is
   testable without a renderer, and so the ONE invariant this whole file
   rests on — the mesh fills exactly [w, h, d] — is enforced by arithmetic
   that a test can read. */

/* Where a revolve's lathe points go, in metres, for a part of this size.
   x is the radius after normalising the profile into the unit box; the
   caller scales z separately, which is what lets a "round" shape be
   drawn oval when the plan asks for one. */
export function revolvePoints(def, size) {
  const [w, h] = size;
  const pts = def.profile;
  let rMax = 0, yLo = Infinity, yHi = -Infinity;
  for (const [r, y] of pts) {
    rMax = Math.max(rMax, Math.abs(r));
    yLo = Math.min(yLo, y); yHi = Math.max(yHi, y);
  }
  const ySpan = Math.max(1e-6, yHi - yLo);
  const rScale = (w / 2) / Math.max(1e-6, rMax);
  return pts.map(([r, y]) => [
    Math.abs(r) * rScale,
    ((y - yLo) / ySpan - 0.5) * h
  ]);
}

/* And the same for an outline: normalised into the unit box, then scaled
   to w × h. Depth is the extrusion and is applied by the caller. */
export function outlinePoints(pts, size) {
  const [w, h] = size;
  let xLo = Infinity, xHi = -Infinity, yLo = Infinity, yHi = -Infinity;
  for (const [x, y] of pts) {
    xLo = Math.min(xLo, x); xHi = Math.max(xHi, x);
    yLo = Math.min(yLo, y); yHi = Math.max(yHi, y);
  }
  const xSpan = Math.max(1e-6, xHi - xLo), ySpan = Math.max(1e-6, yHi - yLo);
  return { pts: pts.map(([x, y]) => [((x - xLo) / xSpan - 0.5) * w, ((y - yLo) / ySpan - 0.5) * h]), xLo, xHi, yLo, yHi, xSpan, ySpan };
}

/* A hole is normalised against the OUTLINE's box, not its own, or a bore
   in the middle of a plate would be blown up to fill it. */
export function holePoints(hole, box, size) {
  const [w, h] = size;
  return hole.map(([x, y]) => [
    ((x - box.xLo) / box.xSpan - 0.5) * w,
    ((y - box.yLo) / box.ySpan - 0.5) * h
  ]);
}

/* ------------------------------------------------------------------ */
/* what the planner is told                                            */
/* ------------------------------------------------------------------ */
/* The prompt cannot carry thirty shapes with a paragraph each — it would
   crowd out the object being asked for. So: the primitives, then one line
   per group, which is enough for a model to reach for `channel` instead of
   describing a channel as three boxes. */
export function shapeBlock() {
  const groups = new Map();
  for (const s of allShapes()) {
    if (s.kind === 'primitive') continue;
    if (!groups.has(s.group)) groups.set(s.group, []);
    groups.get(s.group).push(s.id);
  }
  const lines = [...groups.entries()].map(([g, ids]) => `  ${g}: ${ids.join(', ')}`);
  const mine = customShapes();
  return [
    'SHAPES BEYOND THE PRIMITIVES — use these by name when one fits, they are one part each:',
    ...lines,
    mine.length
      ? `  the shop's own: ${mine.map(s => `${s.id} (${s.note || s.label})`).join('; ')}`
      : ''
  ].filter(Boolean).join('\n');
}

/* Search, for the shape picker. Same ranking idea as the command palette:
   the start of a label beats a word from the middle beats a word it is
   tagged with — written out rather than pulling in a fuzzy matcher. */
export function searchShapes(query) {
  const q = String(query || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const all = allShapes();
  if (!q) return all;
  const score = s => {
    const id = s.id.replace(/[^a-z0-9]/g, '');
    const label = s.label.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (id === q || label === q) return 100;
    if (id.startsWith(q) || label.startsWith(q)) return 80;
    if (id.includes(q) || label.includes(q)) return 60;
    if ((s.words || []).some(w => w.startsWith(q))) return 45;
    if ((s.words || []).some(w => w.includes(q))) return 30;
    if ((s.note || '').toLowerCase().includes(q)) return 15;
    return 0;
  };
  return all
    .map(s => ({ s, n: score(s) }))
    .filter(x => x.n > 0)
    .sort((a, b) => b.n - a.n || a.s.id.localeCompare(b.s.id))
    .map(x => x.s);
}

/* ------------------------------------------------------------------ */
/* making a new one                                                    */
/* ------------------------------------------------------------------ */
/* Starting from scratch with a list of numbers is not a thing anybody
   does, so a new shape starts as a COPY of one that exists — which is
   also why every built-in is stored in the same format a custom one is.
   A shape derived from a primitive gets a plausible profile to edit
   rather than an empty one. */
const PRIMITIVE_SEEDS = {
  box: { kind: 'extrude', outline: [[0, 0], [1, 0], [1, 1], [0, 1]] },
  panel: { kind: 'extrude', outline: [[0, 0], [1, 0], [1, 1], [0, 1]] },
  wedge: { kind: 'extrude', outline: [[0, 0], [1, 0], [0, 1]] },
  gear: { kind: 'extrude', outline: starOutline(9, 0.5, 0.38) },
  cylinder: { kind: 'revolve', profile: R([0, 0], [1, 0], [1, 1], [0, 1]) },
  rod: { kind: 'revolve', profile: R([0, 0], [1, 0], [1, 1], [0, 1]) },
  cone: { kind: 'revolve', profile: R([0, 0], [1, 0], [0, 1]) },
  sphere: { kind: 'revolve', profile: R([0, 0], [0.6, 0.1], [0.92, 0.28], [1, 0.5], [0.92, 0.72], [0.6, 0.9], [0, 1]) },
  torus: { kind: 'revolve', profile: R([0.55, 0], [1, 0], [1, 1], [0.55, 1], [0.55, 0]) }
};

export function newShapeFrom(sourceId, id, label) {
  const src = shapeDef(sourceId) || PRIMITIVE_SEEDS[String(sourceId || '').toLowerCase()];
  if (!src) return null;
  const draft = {
    id, label: label || id, kind: src.kind,
    group: src.group || (src.kind === 'revolve' ? 'turned' : 'plate'),
    note: '', words: [],
    ...(src.kind === 'revolve'
      ? { profile: src.profile.map(p => p.slice()), segments: src.segments || 28 }
      : { outline: src.outline.map(p => p.slice()), ...(src.holes ? { holes: src.holes.map(h => h.map(p => p.slice())) } : {}) })
  };
  return validateShapeDef(draft, { custom: true });
}

/* Adding one to what is already saved, and taking one away. Both return a
   whole new list because that is what gets written to disk — the same
   whole-file discipline the skill library uses, for the same reason. */
export function upsertShape(list, def) {
  const clean = validateShapeDef(def, { custom: true });
  if (!clean) return { ok: false, error: 'that shape has no usable profile', list };
  if (PRIMITIVE_SHAPES.includes(clean.id) || BUILTIN_SHAPES.some(s => s.id === clean.id)) {
    return { ok: false, error: `"${clean.id}" is one the shop already ships — pick another name`, list };
  }
  const next = (Array.isArray(list) ? list : []).filter(s => s.id !== clean.id);
  next.push(clean);
  return { ok: true, list: next, shape: clean };
}

export function removeShape(list, id) {
  const key = String(id || '').toLowerCase();
  const next = (Array.isArray(list) ? list : []).filter(s => s.id !== key);
  return { ok: next.length !== (list || []).length, list: next };
}
