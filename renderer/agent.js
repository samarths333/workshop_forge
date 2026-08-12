import { ACTION_IDS, CLIP_BY_ID, ACTIONS_BY_ROOM } from './animations.js';
import { SHAPES, MATERIALS, FACES, ARRAY_MODES } from './assembly.js';
import { SOURCES, classifyRequest, technicalBlock, domainKnowledge, domainParts } from './library.js';

export const ROOM_KEYS = ['software', 'cardboard', 'finished', 'metal'];
export { SHAPES, MATERIALS };

/* ------------------------------------------------------------------ */
/* schema handed to Ollama for hard structured output                  */
/* ------------------------------------------------------------------ */
const PART_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    shape: { type: 'string', enum: SHAPES },
    material: { type: 'string', enum: MATERIALS },
    size: { type: 'array', items: { type: 'number' } },
    color: { type: 'string' },
    attach: {
      type: 'object',
      properties: {
        to: { type: 'integer' },
        face: { type: 'string', enum: FACES },
        dx: { type: 'number' },
        dy: { type: 'number' },
        dz: { type: 'number' }
      },
      required: ['to', 'face']
    },
    array: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ARRAY_MODES },
        count: { type: 'integer' },
        radius: { type: 'number' },
        spacing: { type: 'number' }
      },
      required: ['mode']
    },
    rot: { type: 'array', items: { type: 'number' } }
  },
  required: ['name', 'shape', 'material', 'size']
};

export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          room: { type: 'string', enum: ROOM_KEYS },
          action: { type: 'string', enum: ACTION_IDS },
          say: { type: 'string' },
          seconds: { type: 'number' },
          part: PART_SCHEMA
        },
        required: ['room', 'action', 'say', 'seconds']
      }
    }
  },
  required: ['title', 'summary', 'steps']
};

/* ------------------------------------------------------------------ */
/* prompt                                                              */
/* ------------------------------------------------------------------ */
function actionMenu() {
  return ROOM_KEYS.map(r => `  ${r}: ${(ACTIONS_BY_ROOM[r] || []).join(', ')}`).join('\n')
    + `\n  any room: ${(ACTIONS_BY_ROOM.any || []).join(', ')}`;
}

const GEOMETRY_RULES = `HOW PARTS GO TOGETHER — READ THIS TWICE
You do NOT give coordinates. You say what each part is BOLTED TO. The shop
works out the arithmetic, drops anything unsupported onto whatever is below
it, and pushes apart anything you drove into itself. Your job is structure.

Number the parts in the order you create them: the first step with a "part"
is part 0, the next is part 1, and so on. Count only steps that have a part.

  "attach": { "to": 0, "face": "top", "dx": 0, "dz": 0 }

    to    the index of the part this one sits on or bolts to.
          Omit "attach" entirely for the part that stands on the pedestal —
          the base, the chassis, the trunk. There is usually exactly one.
    face  top | bottom | left | right | front | back | inside
          top   → stacked on it            (a shade on a stem)
          left/right/front/back → hung off its side, and it will NOT fall,
                                  so this is how you get wheels on a body,
                                  fins on a rocket, a handle on a case
    dx,dy,dz  optional nudge in metres along that face

REPEATED PARTS — do not write four legs as four steps
  "array": { "mode": "quad", "radius": 0.4 }

    quad      four of them at the corners of a square, radius apart
    ring      "count" of them evenly around the centre, each turned to face
              outward — fins, spokes, petals
    mirror_x  a matched pair left and right      (wheels, arms, wings)
    mirror_z  a matched pair front and back
    row       "count" in a line, "spacing" apart (slats, rungs, keys)

  One step, one array, and the shop makes them all. A table has ONE leg part
  with array quad. A rocket has ONE fin part with array ring count 3.

MAKE IT RECOGNISABLE
The parts that identify the object must be present, in the right shape,
attached to the right thing:
  · rocket   long cylinder body · cone nose on its top · fins arrayed ring
             count 3-4 attached to the body's side, low down
  · lamp     wide cylinder base · thin rod stem on top of it · cone shade
             on top of the stem
  · table    panel top, legs as ONE part with array quad attached to the
             top's bottom face
  · vehicle  box chassis · wheels as torus, rot [0,0,90], attached to the
             left face and the right face, each with array mirror_z
  · robot    box torso · head on top · arms mirrored off the sides · legs
             arrayed under it
Vary the shapes. Five boxes in a heap is not an object.
Sizes are [width, height, depth] in metres, each between 0.15 and 2.5, and
they must be in proportion — a stem is thin and tall, a base is wide and flat.
"rot" is optional, in DEGREES, for anything that needs tilting or laying over.
A "torus" is a ring lying flat — [outer diameter, thickness, -]. For a WHEEL
you must stand it on its side with "rot": [0, 0, 90], or it lies down like a
doughnut on a plate.

Worked example — a desk lamp
  part 0  base   cylinder  size [0.5,0.1,0.5]   no attach — it stands on the pedestal
  part 1  stem   rod       size [0.12,0.7,0.12] attach { to:0, face:"top" }
  part 2  shade  cone      size [0.4,0.3,0.4]   attach { to:1, face:"top" }
Worked example — a four-wheeled rover
  part 0  chassis  box    size [1.2,0.25,0.7]   no attach
  part 1  wheel    torus  size [0.36,0.12,0.36] rot [0,0,90]
                                                attach { to:0, face:"left" }
                                                array  { mode:"mirror_z", radius:0.34 }
  part 2  wheel    torus  size [0.36,0.12,0.36] rot [0,0,90]
                                                attach { to:0, face:"right" }
                                                array  { mode:"mirror_z", radius:0.34 }
  part 3  mast     rod    size [0.1,0.5,0.1]    attach { to:0, face:"top", dx:-0.4 }`;

/* What people who actually make this thing have published. Titles carry a
   surprising amount of structure — "phone stand with cable slot and 60
   degree back", "rocket, 4 fins, screw-on nose" — and that is exactly the
   information a model guessing from two words does not have. */
export function referenceBlock(refs) {
  // only the maker sites belong in this block — an encyclopedia article is
  // not "a real published design", and describing it as one invites the
  // planner to copy a title
  refs = (refs || []).filter(r => SOURCES[r.source]?.kind !== 'engineering');
  if (!refs.length) return '';
  const lines = refs.slice(0, 10).map(r => {
    const tags = r.tags?.length ? `\n      tags: ${r.tags.join(', ')}` : '';
    const sum = r.summary ? `\n      "${r.summary.slice(0, 150)}"` : '';
    return `  · ${r.title}   [${r.source}${r.likes ? `, ${r.likes} likes` : ''}]${tags}${sum}`;
  }).join('\n');

  return `
HOW PEOPLE ACTUALLY MAKE THIS
These are real published designs for what was asked for, pulled from
Thingiverse and Printables just now. Read them for STRUCTURE and
VOCABULARY: which parts a real one has, what those parts are called, what
is attached to what, and what proportions people settle on.

${lines}

Use them. If most of them have a part, yours should have that part, and it
should be called what they call it. If they agree on a proportion — a wide
flat base, a back at an angle, a slot at the front — match it. Do NOT copy
a title as your build title, do not invent parts none of them have, and do
not mention these designs in any "say" line. They are reference, not the
order. What was actually asked for still wins where the two disagree.
`;
}

/* An engineering request gets a different block: what the real thing is
   made of, in the right words, rather than what people have published a
   print of. The domain is worked out from the request here so no caller
   has to remember to pass it. */
export function engineeringBlock(request, refs) {
  const d = classifyRequest(request);
  if (!d.engineering) return '';
  return technicalBlock(request, refs, d.domain);
}

export function buildMessages(request, recalled, refs) {
  const system = `You are the shop foreman for a four-room fabrication workshop. A cardboard robot named Rivet does the work with his hands. Your job is to turn a build request into an ordered list of shop steps.

THE ROOMS
  software  — the spec room. A server aisle and one old beige desktop. Rivet drafts, measures and reads here. Produces no physical parts.
  cardboard — the mock-up room. Kraft board, scissors, glue, tape. Fast, cheap, throwaway geometry.
  finished  — the gallery. Assembly, sanding, paint, inspection, final placement on the pedestal.
  metal     — the hard shop. Welding, grinding, hammering, drilling, bending. Real structure.

THE ONLY ACTIONS RIVET KNOWS (exact strings, nothing else):
${actionMenu()}

RULES
1. Return ONLY a JSON object. No prose, no markdown fences.
2. 8 to 16 steps. Real builds move software → cardboard → metal → finished, but revisit rooms when it makes sense.
3. Every step needs "room", "action", "say", "seconds". "action" MUST come from that room's list or the "any room" list.
4. "say" is Rivet's own line, first person, under 12 words, plain and dry. Not chirpy.
5. "seconds" is 2 to 7.
6. Put a "part" on a step ONLY when that operation physically produces a component. 4 to 7 of the steps, never in the software room. Rivet carries every part he makes to the gallery himself, so do not invent parts you do not need.
7. The last step is in "finished", action "present".

${GEOMETRY_RULES}
${referenceBlock(refs)}${engineeringBlock(request, refs)}${recalledBlock(recalled)}
SHAPE OF THE OUTPUT
{"title":"...","summary":"one sentence","steps":[{"room":"metal","action":"weld","say":"Welding the legs on.","seconds":5,"part":{"name":"leg","shape":"rod","material":"metal","size":[0.12,0.7,0.12],"attach":{"to":0,"face":"bottom"},"array":{"mode":"quad","radius":0.42}}}]}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: `Build request: ${request}` }
  ];
}

/* Everything Rivet has learned about this kind of object, folded into the
   prompt. This is the recall half of the skill loop — the recipe handed
   back is one that already passed inspection on the shop floor. */
function recalledBlock(recalled) {
  if (!recalled || !recalled.skill) return '';
  const s = recalled.skill;
  const parts = (s.recipe?.parts || []).map((p, i) => {
    const at = p.attach ? `attach {to:${p.attach.to}, face:"${p.attach.face}"${p.attach.dx ? `, dx:${p.attach.dx}` : ''}${p.attach.dy ? `, dy:${p.attach.dy}` : ''}${p.attach.dz ? `, dz:${p.attach.dz}` : ''}}` : 'stands on the pedestal';
    const ar = p.array ? `  array {mode:"${p.array.mode}"${p.array.count ? `, count:${p.array.count}` : ''}${p.array.radius ? `, radius:${p.array.radius}` : ''}}` : '';
    return `  part ${i}  ${p.role || p.name}  ${p.shape} in ${p.material}  size [${(p.size || []).join(',')}]  ${at}${ar}`;
  }).join('\n');

  const process = (s.recipe?.process || []).map(p => `  ${p.room} · ${p.action}${p.part != null ? ` → part ${p.part}` : ''}`).join('\n');
  const lessons = (s.lessons || []).map(l => `  · ${l}`).join('\n');

  const taught = (s.stats?.taught || 0) > 0;
  const provenance = taught
    ? `A PERSON CORRECTED THIS ONE BY HAND on the bench and signed it off. It is the most reliable thing you have. Follow its structure closely — the shapes, what is attached to what, and the proportions between parts. Change sizes and add detail parts to suit what was asked for this time, but do not restructure it, and do not undo the corrections listed below.`
    : `He has built "${s.name}" ${s.stats?.uses || 1} time${(s.stats?.uses || 1) === 1 ? '' : 's'} before and this version passed inspection. Start from it. Keep the structure that worked; change sizes, materials and detail parts to suit what was actually asked for this time. Do not throw it away and start over, and do not copy it blindly if the request differs.`;

  return `
WHAT RIVET ALREADY KNOWS ABOUT THIS
${provenance}

  PROVEN STRUCTURE
${parts || '  (no parts recorded)'}
${process ? `\n  PROVEN ORDER OF OPERATIONS\n${process}` : ''}
${lessons ? `\n  ${taught ? 'WHAT WAS CORRECTED BY HAND — THESE ARE NOT SUGGESTIONS' : 'WHAT WENT WRONG LAST TIME, ALREADY CORRECTED ABOVE'}\n${lessons}` : ''}
`;
}

/* ------------------------------------------------------------------ */
/* self-check — look at what got built and fix it                      */
/* ------------------------------------------------------------------ */
export const REVISE_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['good', 'fix'] },
    reads_as: { type: 'string' },
    problems: { type: 'array', items: { type: 'string' } },
    parts: {
      type: 'array',
      items: {
        type: 'object',
        properties: Object.assign({ i: { type: 'integer' } }, PART_SCHEMA.properties),
        required: ['i', 'shape', 'size']
      }
    }
  },
  required: ['verdict', 'reads_as', 'problems', 'parts']
};

export function buildCritiqueMessages(request, plan, issues, description, refs) {
  const found = issues.length ? issues.map(s => `  · ${s}`).join('\n') : '  · none — the geometry is sound';
  const against = refs?.length
    ? `\nWHAT A REAL ONE HAS\nPublished designs for this, for comparison. If they all have a part and this build does not, that is a fault worth listing:\n${refs.slice(0, 8).map(r => `  · ${r.title}${r.tags?.length ? ` — ${r.tags.slice(0, 4).join(', ')}` : ''}`).join('\n')}\n`
    : '';

  /* The inspector gets the engineering vocabulary too, otherwise it passes
     a "turbofan" that is a tube with a cone on it — it has no way to know
     that a real one has a fan, a compressor, a combustor and a turbine. */
  const k = domainKnowledge(classifyRequest(request).domain);
  const expected = k
    ? `\nWHAT ONE OF THESE IS MADE OF\n${k.note}\nA real one has: ${k.parts.join(', ')}.\nA build missing the parts that define it fails, however tidy the geometry is.\n`
    : '';

  const system = `You are inspecting a build on the shop pedestal before Rivet starts cutting. Be blunt. Would someone who asked for this recognise it?

You get the parts as they will actually stand once assembled — the shop has already resolved every attachment, dropped anything unsupported onto the part below it, and separated anything overlapping. So the positions below are real. Judge the OBJECT, not the arithmetic.

A build fails if it is a heap of primitives, if the features that identify the object are missing or the wrong shape, or if the proportions are nonsense:
  · a rocket needs a long body, a pointed nose and fins standing off the base
  · a lamp needs a wide base, a thin stem and a shade at the top
  · a chair or table needs legs holding a surface up off the pedestal
  · a vehicle needs wheels on its sides, not slabs underneath it
  · a robot needs a torso with limbs and a head above it

GEOMETRY ALREADY CHECKED AUTOMATICALLY:
${found}
${against}${expected}
RULES
1. Return ONLY a JSON object. No prose, no fences.
2. "reads_as" is what this currently looks like to you, plainly. If it looks like nothing, say so.
3. "verdict" is "good" ONLY if it already reads as the thing that was ordered.
4. "problems" lists what is wrong, one short sentence each.
5. "parts" is the CORRECTED full parts list — every part, not only the ones you changed. Keep "i" as the part's original index; to add a missing part give it the next unused index.
${GEOMETRY_RULES}
6. If the verdict is "good", return the parts list unchanged.`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: `Ordered: ${request}\n\nPlanned (${plan.title}) — as it will actually stand:\n${description}\n\nDoes that read as "${request}"?` }
  ];
}

/* Fold a revision back onto the plan. Parts are matched by their index in
   the plan's part sequence; extra parts get hung off the last shaping step
   so Rivet is still seen making them. */
export function applyRevision(plan, rev) {
  if (!rev || !Array.isArray(rev.parts)) return { plan, changed: 0 };
  const partSteps = plan.steps.filter(s => s.part);
  let changed = 0;

  for (const p of rev.parts) {
    const i = Number(p.i);
    if (!Number.isInteger(i) || i < 0) continue;
    if (i < partSteps.length) {
      const before = JSON.stringify(partSteps[i].part);
      partSteps[i].part = mergePart(partSteps[i].part, p);
      if (JSON.stringify(partSteps[i].part) !== before) changed++;
    } else {
      const host = [...plan.steps].reverse().find(s => !s.part && s.room !== 'software')
                || plan.steps[Math.max(0, plan.steps.length - 2)];
      if (host && !host.part) { host.part = mergePart({ name: 'part' }, p); changed++; }
    }
  }
  return { plan, changed };
}

function mergePart(base, p) {
  const size = Array.isArray(p.size) ? p.size : base.size;
  const out = {
    name: String(p.name || base.name || 'part').slice(0, 40),
    shape: SHAPES.includes(String(p.shape).toLowerCase()) ? String(p.shape).toLowerCase() : base.shape,
    material: MATERIALS.includes(String(p.material).toLowerCase()) ? String(p.material).toLowerCase() : base.material,
    size: [0, 1, 2].map(i => clamp(Number(size?.[i]) || 0.4, 0.15, 2.5)),
    color: base.color || null
  };
  if (p.attach) out.attach = p.attach;
  else if (base.attach) out.attach = base.attach;
  if (p.array) out.array = p.array;
  else if (base.array) out.array = base.array;
  if (Array.isArray(p.at) && p.at.slice(0, 3).every(v => Number.isFinite(Number(v)))) {
    out.at = [clamp(Number(p.at[0]), -2.4, 2.4), clamp(Number(p.at[1]), 0, 4), clamp(Number(p.at[2]), -2.4, 2.4)];
  } else if (base.at) out.at = base.at;
  // rot stays in DEGREES here — the merged plan goes back through validatePlan,
  // which is the single place that converts to radians. Converting here too
  // would apply the conversion twice and flatten every angle to near zero.
  if (Array.isArray(p.rot) && p.rot.slice(0, 3).every(v => Number.isFinite(Number(v)))) {
    out.rot = [0, 1, 2].map(i => clamp(Number(p.rot[i]), -180, 180));
  } else if (base.rot) {
    out.rot = base.rot.map(r => (r * 180) / Math.PI);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* reflection — what to keep from a build that is now finished          */
/* ------------------------------------------------------------------ */
export const REFLECT_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    object_class: { type: 'string' },
    keywords: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    roles: {
      type: 'array',
      items: {
        type: 'object',
        properties: { i: { type: 'integer' }, role: { type: 'string' } },
        required: ['i', 'role']
      }
    },
    lessons: { type: 'array', items: { type: 'string' } },
    reuse_when: { type: 'string' }
  },
  required: ['name', 'object_class', 'keywords', 'summary', 'roles', 'lessons', 'reuse_when']
};

export function buildReflectMessages(request, plan, description, history) {
  const system = `A build has just come off the shop floor. Write down what is worth keeping, so the next build of this kind starts from it instead of from nothing.

You are not judging the build — it is already made and on the pedestal. You are labelling it for recall.

RULES
1. Return ONLY a JSON object. No prose, no fences.
2. "object_class" is one lowercase word for the family of thing this is: lamp, table, chair, rocket, vehicle, robot, shelf, enclosure, bracket, instrument, tool. Pick the closest one. This is the key the shop files it under, so be consistent and generic — a "desk lamp with a folding arm" and a "bedside reading light" are both class "lamp".
3. "keywords" is 5 to 10 lowercase single words that a future request for this same kind of thing would plausibly contain. Include synonyms the request itself did not use.
4. "roles" names what each part IS structurally — "base", "stem", "shade", "left front wheel", "fin". One entry per part index. This is what makes the stored recipe legible next time.
5. "lessons" is the useful part. 1 to 4 short sentences, each a rule that would make the NEXT build of this class better. Write rules about SHAPE and STRUCTURE, not about this specific request. Good: "the shade has to be a cone attached to the top of the stem, or it reads as a box on a stick." Useless: "the build went well." If corrections were made during inspection, the lesson is whatever the correction taught. If nothing was corrected, say what the defining feature of this class turned out to be.
6. "reuse_when" is one sentence describing the kind of request this recipe should be pulled out for.`;

  const hist = history && history.length ? `\n\nWhat inspection caught and corrected:\n${history.map(h => '  · ' + h).join('\n')}` : '\n\nInspection found nothing to correct — this one was right first time.';

  return [
    { role: 'system', content: system },
    { role: 'user', content: `Ordered: ${request}\n\nBuilt (${plan.title}) — final parts as they stand on the pedestal:\n${description}${hist}` }
  ];
}

/* ------------------------------------------------------------------ */
/* validation — never trust the model                                  */
/* ------------------------------------------------------------------ */
export function parsePlan(text) {
  let raw = String(text).trim();
  raw = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('no JSON object in the reply');
  return JSON.parse(raw.slice(a, b + 1));
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function validAttach(raw, ownIndex) {
  if (!raw || typeof raw !== 'object') return null;
  const to = Math.round(Number(raw.to));
  // parents must already exist, which also makes attachment cycles impossible
  if (!Number.isInteger(to) || to < 0 || to >= ownIndex) return null;
  const face = FACES.includes(String(raw.face || '').toLowerCase()) ? String(raw.face).toLowerCase() : 'top';
  const out = { to, face };
  for (const k of ['dx', 'dy', 'dz']) {
    const v = Number(raw[k]);
    if (Number.isFinite(v) && v !== 0) out[k] = clamp(v, -2.5, 2.5);
  }
  return out;
}

function validArray(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const mode = String(raw.mode || '').toLowerCase();
  if (!ARRAY_MODES.includes(mode) || mode === 'none') return null;
  const out = { mode };
  const count = Math.round(Number(raw.count));
  out.count = Number.isInteger(count) ? clamp(count, 2, 8) : (mode === 'ring' ? 3 : 4);
  const radius = Number(raw.radius);
  out.radius = Number.isFinite(radius) ? clamp(radius, 0.05, 2) : 0.4;
  const spacing = Number(raw.spacing);
  if (Number.isFinite(spacing)) out.spacing = clamp(spacing, 0.05, 2);
  return out;
}

export function validatePlan(p, fallbackTitle = 'Untitled build') {
  const out = {
    title: String(p?.title || fallbackTitle).slice(0, 80),
    summary: String(p?.summary || '').slice(0, 240),
    steps: []
  };
  const steps = Array.isArray(p?.steps) ? p.steps : [];
  let partIndex = 0;

  for (const s of steps) {
    let room = String(s?.room || '').toLowerCase();
    if (!ROOM_KEYS.includes(room)) room = 'cardboard';

    let action = String(s?.action || '').toLowerCase().replace(/\s+/g, '_');
    if (!CLIP_BY_ID[action]) {
      const pool = (ACTIONS_BY_ROOM[room] || []).concat(ACTIONS_BY_ROOM.any || []);
      action = pool[0] || 'idle';
    }
    const clipRoom = CLIP_BY_ID[action].room;
    if (clipRoom && clipRoom !== room) room = clipRoom;

    const step = {
      room, action,
      say: String(s?.say || CLIP_BY_ID[action].label).slice(0, 90),
      seconds: Math.max(1.5, Math.min(9, Number(s?.seconds) || 4))
    };

    if (s?.part && room !== 'software') {
      const size = Array.isArray(s.part.size) ? s.part.size : [0.6, 0.4, 0.4];
      step.part = {
        name: String(s.part.name || 'part').slice(0, 40),
        shape: SHAPES.includes(String(s.part.shape).toLowerCase()) ? String(s.part.shape).toLowerCase() : 'box',
        material: MATERIALS.includes(String(s.part.material).toLowerCase())
          ? String(s.part.material).toLowerCase()
          : (room === 'metal' ? 'metal' : 'cardboard'),
        size: [0, 1, 2].map(i => Math.max(0.15, Math.min(2.5, Number(size[i]) || 0.4))),
        color: typeof s.part.color === 'string' && /^#?[0-9a-f]{6}$/i.test(s.part.color.replace('#', '')) ? s.part.color : null
      };

      const attach = validAttach(s.part.attach, partIndex);
      if (attach) step.part.attach = attach;
      const arr = validArray(s.part.array);
      if (arr) step.part.array = arr;

      // absolute placement is still honoured, but only for a part that is
      // not attached to anything — the solver owns everything else
      const at = Array.isArray(s.part.at) ? s.part.at : null;
      if (!attach && at && at.length >= 3 && at.slice(0, 3).every(v => Number.isFinite(Number(v)))) {
        step.part.at = [
          clamp(Number(at[0]), -2.4, 2.4),
          clamp(Number(at[1]), 0, 4),
          clamp(Number(at[2]), -2.4, 2.4)
        ];
      }
      const rot = Array.isArray(s.part.rot) ? s.part.rot : null;
      if (rot && rot.length >= 3 && rot.slice(0, 3).every(v => Number.isFinite(Number(v)))) {
        step.part.rot = [0, 1, 2].map(i => (clamp(Number(rot[i]), -180, 180) * Math.PI) / 180);
      }
      partIndex++;
    }
    out.steps.push(step);
    if (out.steps.length >= 18) break;
  }
  if (!out.steps.length) throw new Error('plan had no usable steps');

  const last = out.steps[out.steps.length - 1];
  if (last.room !== 'finished') {
    out.steps.push({ room: 'finished', action: 'present', say: 'Done. Have a look.', seconds: 4 });
  }
  return out;
}

/* Every part spec in the plan, in the order the model numbered them. */
export function planParts(plan) {
  return plan.steps.filter(s => s.part).map(s => s.part);
}

/* ------------------------------------------------------------------ */
/* editing a plan by hand, from the CAD bench                          */
/* ------------------------------------------------------------------ */
/* Parts are addressed by their position in the part sequence, and every
   attachment points at one of those positions — so adding or removing a
   part means renumbering every attachment that pointed past it. Getting
   this wrong silently reparents half the assembly. */
function reindexAttachments(plan, remap) {
  let i = 0;
  for (const step of plan.steps) {
    if (!step.part) continue;
    const a = step.part.attach;
    if (a) {
      const to = remap(a.to);
      if (to == null || to >= i) delete step.part.attach;      // parent is gone, or would point forward
      else a.to = to;
    }
    i++;
  }
  return plan;
}

/* Drop a part. The step that made it goes with it — an operation that
   produces nothing is not an operation. */
export function removePart(plan, index) {
  let n = 0, target = -1;
  plan.steps.forEach((s, si) => { if (s.part) { if (n === index) target = si; n++; } });
  if (target < 0) return plan;
  plan.steps.splice(target, 1);
  reindexAttachments(plan, to => (to === index ? null : to > index ? to - 1 : to));
  if (!plan.steps.some(s => s.room === 'finished')) {
    plan.steps.push({ room: 'finished', action: 'present', say: 'Done. Have a look.', seconds: 4 });
  }
  return plan;
}

const ROOM_FOR_MATERIAL = {
  cardboard: { room: 'cardboard', action: 'cut_scissors', say: 'Cutting one more piece.' },
  metal:     { room: 'metal',     action: 'saw_metal',    say: 'Cutting one more piece.' },
  wood:      { room: 'finished',  action: 'assemble',     say: 'Fitting one more piece.' },
  plastic:   { room: 'finished',  action: 'assemble',     say: 'Fitting one more piece.' },
  painted:   { room: 'finished',  action: 'paint',        say: 'One more, painted.' },
  glass:     { room: 'finished',  action: 'polish',       say: 'One more, buffed up.' }
};

/* Add a part on the end of the run, just before he presents it. Indices of
   existing parts are untouched, which is why it goes on the end. */
export function addPart(plan, spec = {}) {
  const material = MATERIALS.includes(spec.material) ? spec.material : 'metal';
  const recipe = ROOM_FOR_MATERIAL[material] || ROOM_FOR_MATERIAL.metal;
  const part = {
    name: spec.name || 'new part',
    shape: SHAPES.includes(spec.shape) ? spec.shape : 'box',
    material,
    size: (spec.size || [0.4, 0.4, 0.4]).map(v => clamp(Number(v) || 0.4, 0.15, 2.5)),
    color: null
  };
  const existing = planParts(plan).length;
  if (existing > 0) part.attach = { to: existing - 1, face: 'top' };

  const step = { room: recipe.room, action: recipe.action, say: recipe.say, seconds: 4, part };
  // in front of the last finished-room step, so he still ends by presenting
  let at = plan.steps.length;
  for (let i = plan.steps.length - 1; i >= 0; i--) {
    if (plan.steps[i].room === 'finished' && !plan.steps[i].part) at = i; else break;
  }
  plan.steps.splice(at, 0, step);
  return { plan, index: existing };
}

/* Apply one field change from the properties panel. Everything is clamped
   here rather than trusted from the DOM, for the same reason validatePlan
   exists: the input is not the contract. */
export function editPart(plan, index, patch) {
  const parts = planParts(plan);
  const p = parts[index];
  if (!p) return plan;

  if (patch.name !== undefined) p.name = String(patch.name).slice(0, 40) || 'part';
  if (patch.shape !== undefined && SHAPES.includes(patch.shape)) p.shape = patch.shape;
  if (patch.material !== undefined && MATERIALS.includes(patch.material)) p.material = patch.material;

  for (const [k, ax] of [['sx', 0], ['sy', 1], ['sz', 2]]) {
    if (patch[k] !== undefined) p.size[ax] = clamp(Number(patch[k]) || 0.4, 0.15, 2.5);
  }
  for (const [k, ax] of [['rx', 0], ['ry', 1], ['rz', 2]]) {
    if (patch[k] === undefined) continue;
    p.rot = p.rot || [0, 0, 0];
    p.rot[ax] = (clamp(Number(patch[k]) || 0, -180, 180) * Math.PI) / 180;
  }
  if (p.rot && !p.rot.some(v => v)) delete p.rot;

  if (patch.to !== undefined) {
    const to = patch.to === '' || patch.to == null ? null : Math.round(Number(patch.to));
    if (to == null || !Number.isInteger(to) || to < 0 || to >= index) delete p.attach;
    else p.attach = { ...(p.attach || {}), to, face: p.attach?.face || 'top' };
  }
  if (patch.face !== undefined && p.attach && FACES.includes(patch.face)) p.attach.face = patch.face;
  for (const k of ['dx', 'dy', 'dz']) {
    if (patch[k] === undefined || !p.attach) continue;
    const v = clamp(Number(patch[k]) || 0, -2.5, 2.5);
    if (v === 0) delete p.attach[k]; else p.attach[k] = v;
  }

  if (patch.mode !== undefined) {
    if (!ARRAY_MODES.includes(patch.mode) || patch.mode === 'none') delete p.array;
    else p.array = { mode: patch.mode, count: p.array?.count ?? 4, radius: p.array?.radius ?? 0.4 };
  }
  if (patch.count !== undefined && p.array) p.array.count = clamp(Math.round(Number(patch.count) || 4), 2, 8);
  if (patch.radius !== undefined && p.array) p.array.radius = clamp(Number(patch.radius) || 0.4, 0.05, 2);

  return plan;
}

/* ------------------------------------------------------------------ */
/* offline planner — keyword heuristics, so the shop never sits idle    */
/* ------------------------------------------------------------------ */
const HINTS = [
  {
    re: /\b(lamp|light|lantern|sconce|shade)\b/i, metal: true,
    parts: [
      { name: 'base', shape: 'cylinder', material: 'metal', size: [0.5, 0.12, 0.5] },
      { name: 'stem', shape: 'rod', material: 'metal', size: [0.14, 0.8, 0.14], attach: { to: 0, face: 'top' } },
      { name: 'shade', shape: 'cone', material: 'painted', size: [0.44, 0.32, 0.44], attach: { to: 1, face: 'top' } }
    ]
  },
  {
    re: /\b(chair|stool|bench|seat|table|desk)\b/i, metal: true,
    parts: [
      { name: 'top', shape: 'panel', material: 'wood', size: [1.2, 0.08, 0.9] },
      { name: 'leg', shape: 'rod', material: 'metal', size: [0.12, 0.68, 0.12], attach: { to: 0, face: 'bottom' }, array: { mode: 'quad', radius: 0.44, count: 4 } },
      { name: 'rail', shape: 'rod', material: 'metal', size: [0.1, 0.9, 0.1], attach: { to: 0, face: 'bottom', dy: -0.5 }, rot: [0, 0, 90] }
    ]
  },
  {
    re: /\b(robot|droid|bot|mech)\b/i, metal: true,
    parts: [
      { name: 'torso', shape: 'box', material: 'metal', size: [0.6, 0.8, 0.4] },
      { name: 'leg', shape: 'rod', material: 'metal', size: [0.16, 0.6, 0.16], attach: { to: 0, face: 'bottom' }, array: { mode: 'mirror_x', radius: 0.18, count: 2 } },
      { name: 'head', shape: 'box', material: 'painted', size: [0.34, 0.3, 0.34], attach: { to: 0, face: 'top' } },
      { name: 'arm', shape: 'rod', material: 'metal', size: [0.14, 0.62, 0.14], attach: { to: 0, face: 'left', dy: 0.1 }, array: { mode: 'mirror_x', radius: 0.4, count: 2 } }
    ]
  },
  {
    re: /\b(car|truck|rover|cart|vehicle|wheel|chassis)\b/i, metal: true,
    parts: [
      { name: 'chassis', shape: 'box', material: 'metal', size: [1.3, 0.24, 0.72] },
      { name: 'wheel', shape: 'torus', material: 'plastic', size: [0.38, 0.13, 0.38], rot: [0, 0, 90], attach: { to: 0, face: 'left' }, array: { mode: 'mirror_z', radius: 0.36, count: 2 } },
      { name: 'wheel', shape: 'torus', material: 'plastic', size: [0.38, 0.13, 0.38], rot: [0, 0, 90], attach: { to: 0, face: 'right' }, array: { mode: 'mirror_z', radius: 0.36, count: 2 } },
      { name: 'body', shape: 'wedge', material: 'painted', size: [0.8, 0.36, 0.6], attach: { to: 0, face: 'top' } }
    ]
  },
  {
    re: /\b(rocket|missile|plane|drone|glider|wing)\b/i, metal: true,
    parts: [
      { name: 'body', shape: 'cylinder', material: 'metal', size: [0.44, 1.5, 0.44] },
      { name: 'nose', shape: 'cone', material: 'painted', size: [0.44, 0.5, 0.44], attach: { to: 0, face: 'top' } },
      { name: 'fin', shape: 'panel', material: 'metal', size: [0.34, 0.42, 0.5], attach: { to: 0, face: 'right', dy: -0.5 }, array: { mode: 'ring', count: 3, radius: 0.26 } }
    ]
  },
  {
    re: /\b(shelf|rack|stand|mount|bridge|tower|frame)\b/i, metal: true,
    parts: [
      { name: 'upright', shape: 'panel', material: 'wood', size: [0.3, 1.3, 0.7], attach: null, array: { mode: 'mirror_x', radius: 0.7, count: 2 } },
      { name: 'shelf board', shape: 'panel', material: 'wood', size: [1.5, 0.07, 0.6], attach: { to: 0, face: 'top' } },
      { name: 'brace', shape: 'rod', material: 'metal', size: [0.09, 1.4, 0.09], attach: { to: 1, face: 'top' }, rot: [0, 0, 90] }
    ]
  },
  {
    re: /\b(box|crate|case|enclosure|housing|bin)\b/i, metal: false,
    parts: [
      { name: 'floor panel', shape: 'panel', material: 'cardboard', size: [1.0, 0.06, 0.8] },
      { name: 'side wall', shape: 'panel', material: 'cardboard', size: [1.0, 0.6, 0.1], attach: { to: 0, face: 'back' }, array: { mode: 'mirror_z', radius: 0.4, count: 2 } },
      { name: 'end wall', shape: 'panel', material: 'cardboard', size: [0.8, 0.6, 0.1], attach: { to: 0, face: 'left' }, rot: [0, 90, 0], array: { mode: 'mirror_x', radius: 0.5, count: 2 } },
      { name: 'lid', shape: 'panel', material: 'cardboard', size: [1.04, 0.05, 0.84], attach: { to: 1, face: 'top' } }
    ]
  },
  {
    re: /\b(gear|machine|mechanism|clock|automat)\b/i, metal: true,
    parts: [
      { name: 'plate', shape: 'panel', material: 'metal', size: [1.0, 0.08, 1.0] },
      { name: 'post', shape: 'rod', material: 'metal', size: [0.12, 0.5, 0.12], attach: { to: 0, face: 'top' }, array: { mode: 'mirror_x', radius: 0.3, count: 2 } },
      { name: 'gear', shape: 'gear', material: 'metal', size: [0.6, 0.1, 0.6], attach: { to: 1, face: 'top' } },
      { name: 'crank', shape: 'rod', material: 'painted', size: [0.09, 0.42, 0.09], attach: { to: 2, face: 'top' } }
    ]
  }
];

const GENERIC = [
  { name: 'base plate', shape: 'panel', material: 'metal', size: [1.0, 0.08, 0.8] },
  { name: 'upright', shape: 'rod', material: 'metal', size: [0.16, 0.8, 0.16], attach: { to: 0, face: 'top' }, array: { mode: 'mirror_x', radius: 0.34, count: 2 } },
  { name: 'crossbar', shape: 'box', material: 'painted', size: [0.9, 0.16, 0.3], attach: { to: 1, face: 'top' } }
];

/* An offline build is only crude because there is no model to ask. If Rivet
   has already learned this class of object, the recipe he learned is better
   than any keyword table, so it wins. */
export function offlinePlan(request, recalled) {
  const learned = recalled?.skill?.recipe?.parts?.length ? recalled.skill.recipe.parts : null;
  /* With no engine and nothing recalled, an engineering request would fall
     through to the generic box stack — the one case where the offline
     planner was genuinely useless. The domain vocabulary is a far better
     starting point than three boxes. */
  const d = learned ? null : classifyRequest(request);
  const engineered = d?.engineering ? domainParts(d.domain) : null;
  const hint = learned ? { parts: learned, metal: true }
    : engineered ? { parts: engineered, metal: true }
    : (HINTS.find(h => h.re.test(request)) || { parts: GENERIC, metal: true });
  const title = request.trim().replace(/^(build|make|design|create)\s+(me\s+)?(an?\s+)?/i, '').slice(0, 60) || 'Shop build';

  const parts = hint.parts.map(p => ({
    name: p.role || p.name || p.shape,
    shape: p.shape, material: p.material,
    size: (p.size || [0.5, 0.5, 0.5]).slice(),
    attach: p.attach ? { ...p.attach } : undefined,
    array: p.array ? { ...p.array } : undefined,
    rot: p.rot ? p.rot.slice() : undefined
  }));

  const MAKE = {
    cardboard: [['cut_scissors', 'Cutting %s out of board.'], ['score_fold', 'Creasing %s.'], ['glue', 'Gluing %s up.']],
    metal: [['saw_metal', 'Cutting %s to length.'], ['weld', 'Welding %s.'], ['bend_metal', 'Bending %s.'], ['drill', 'Drilling %s.']],
    finished: [['assemble', 'Fitting %s.'], ['sand', 'Cleaning %s up.']]
  };

  const steps = [
    { room: 'software', action: 'boot_pc', say: 'Waking the old box up.', seconds: 3 },
    { room: 'software', action: 'type', say: learned ? 'Pulling up the build I already know.' : 'Drafting the layout.', seconds: 5 },
    { room: 'software', action: 'read_screen', say: 'Checking the numbers twice.', seconds: 3 },
    { room: 'cardboard', action: 'measure', say: 'Measuring the stock.', seconds: 4 },
    { room: 'cardboard', action: 'draw_marker', say: 'Marking the cut lines.', seconds: 3 }
  ];

  parts.forEach((part, i) => {
    const room = part.material === 'cardboard' ? 'cardboard' : (part.material === 'wood' || part.material === 'plastic' ? 'finished' : 'metal');
    const menu = MAKE[room] || MAKE.metal;
    const [action, line] = menu[i % menu.length];
    steps.push({ room, action, say: line.replace('%s', 'the ' + part.name).slice(0, 88), seconds: 4 + (i % 3), part });
  });

  steps.push(
    { room: 'finished', action: 'assemble', say: 'Fitting it all together.', seconds: 5 },
    { room: 'finished', action: 'sand', say: 'Knocking the edges down.', seconds: 3 },
    { room: 'finished', action: 'inspect', say: 'Squaring it up.', seconds: 3 },
    { room: 'finished', action: 'present', say: 'That is the build.', seconds: 4 }
  );

  return {
    title,
    summary: learned
      ? `Built offline from the recipe Rivet learned for ${recalled.skill.name}.`
      : 'Planned offline from keyword heuristics — no model was reachable.',
    steps
  };
}
