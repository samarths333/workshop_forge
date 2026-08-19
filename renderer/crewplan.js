/* THE SPECIALISTS' HALF — one brief each, and the merge that turns four
   answers into one object.

   A specialist is asked a much smaller question than the old single prompt
   ever was: here is the frame, here are the mount points on it, here is your
   brief, you have three parts and these materials, go. That is a question a
   small model can answer well, and it is why the objects that come off this
   floor are better than the ones that came off the old one — not because
   there are more calls, but because each call is about something a model can
   actually hold in its head.

   Then mergeSubplans does the arithmetic. Every specialist numbers its own
   parts from zero and refers to the frame only through mount NAMES, so
   nothing it says depends on what any other specialist did. The merge walks
   the crew in a fixed order, offsets each block of parts, rewrites every
   local attachment into a global one and resolves every mount name into a
   real attachment on a real frame part. Get that renumbering wrong and half
   the object silently reparents onto the wrong thing — which is exactly the
   failure the old addPart/removePart tests exist to catch, so this one is
   tested the same way.

   Pure. No three.js, no DOM. */

import { SHAPES, MATERIALS, FACES, ARRAY_MODES } from './assembly.js';
import { SHAPE_ENUM, isShape } from './shapelib.js';
import {
  SPECIALISTS, roleById, roleBlock, roleForMaterial, actionFor, stationOf,
  clampMaterial, clampShape, budgetOf, makesParts, FOREMAN
} from './roles.js';
import { COMPONENT_IDS, COMPONENTS, isComponent, bodyFor } from './circuit.js';
import { ENGINE_ROLES, describeEngine, sizeEngine, engineParts } from './engine.js';
import { MOVERS } from './catalog.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);

/* ------------------------------------------------------------------ */
/* what a specialist is allowed to hand back                           */
/* ------------------------------------------------------------------ */
export const SUBPLAN_SCHEMA = {
  type: 'object',
  properties: {
    notes: { type: 'string' },
    parts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          shape: { type: 'string', enum: SHAPE_ENUM },
          material: { type: 'string', enum: MATERIALS },
          size: { type: 'array', items: { type: 'number' } },
          rot: { type: 'array', items: { type: 'number' } },
          /* a mount NAME on the frame — the interface */
          mount: { type: 'string' },
          /* a nudge off that mount, in metres. Only read WITH a mount — an
             attachment carries its own. A sump hangs off the underside of
             a block by a real distance, and dropping that on the way
             through the merge stands the engine on its crankshaft. */
          dx: { type: 'number' }, dy: { type: 'number' }, dz: { type: 'number' },
          /* or an attachment to one of THIS specialist's own earlier parts */
          attach: {
            type: 'object',
            properties: {
              to: { type: 'integer' }, face: { type: 'string', enum: FACES },
              dx: { type: 'number' }, dy: { type: 'number' }, dz: { type: 'number' }
            },
            required: ['to', 'face']
          },
          array: {
            type: 'object',
            properties: {
              mode: { type: 'string', enum: ARRAY_MODES }, count: { type: 'integer' },
              radius: { type: 'number' }, spacing: { type: 'number' }
            },
            required: ['mode']
          },
          component: { type: 'string', enum: COMPONENT_IDS },
          value: { type: 'number' },
          /* which bit of the engine this is — the powerplant trade's
             equivalent of `component`, and sized the same way */
          engine_role: { type: 'string', enum: ENGINE_ROLES },
          /* a part that TURNS once the thing is switched on */
          moves: { type: 'string', enum: MOVERS },
          say: { type: 'string' }
        },
        required: ['name', 'shape', 'size']
      }
    },
    wires: {
      type: 'array',
      items: {
        type: 'object',
        properties: { from: { type: 'string' }, to: { type: 'string' } },
        required: ['from', 'to']
      }
    }
  },
  required: ['parts']
};

/* Controls hands back words, not parts — a different schema entirely,
   because giving it a parts array is an invitation to fill one in. */
export const SPEC_SCHEMA = {
  type: 'object',
  properties: {
    notes: { type: 'string' },
    requirements: { type: 'array', items: { type: 'string' } },
    checks: { type: 'array', items: { type: 'string' } }
  },
  required: ['requirements']
};

/* ------------------------------------------------------------------ */
/* the brief                                                           */
/* ------------------------------------------------------------------ */
function frameBlock(order) {
  const parts = order.frame.map((p, i) => {
    const at = p.attach ? `bolted to frame part ${p.attach.to}, ${p.attach.face} face` : 'stands on the pedestal';
    return `  frame part ${i}  ${p.name}  —  ${p.shape} in ${p.material}, ${p.size.map(n => n.toFixed(2)).join(' × ')} m, ${at}`;
  }).join('\n');

  const mounts = order.mounts.map(m => {
    const on = order.frame[m.on];
    const nudge = ['dx', 'dy', 'dz'].filter(k => m[k]).map(k => `${k} ${m[k]}`).join(', ');
    return `  "${m.id}"  →  the ${m.face} of ${on ? on.name : `frame part ${m.on}`}${nudge ? ` (offset ${nudge})` : ''}${m.note ? `  — ${m.note}` : ''}`;
  }).join('\n');

  return `THE FRAME — ALREADY BUILT, NOT YOURS TO CHANGE
${parts}

MOUNT POINTS YOU CAN BOLT TO
${mounts}`;
}

/* What the powerplant specialist is handed. It is not asked for a single
   dimension — the shop has already sized every part from the governing
   numbers, so all it has to do is name the parts and say where they mount.
   Anything it invents for a size is discarded on the way through
   validatePlan, and telling it that up front is cheaper than letting it
   spend its budget on numbers nobody will read. */
function engineBrief(engine) {
  const said = describeEngine({ engine });
  const roles = engineParts(sizeEngine(engine)).map(p => `${p.engine_role} (${p.name})`);
  return `
THE ENGINE IS ALREADY SIZED. THESE ARE ITS NUMBERS
${said.split('\n').map(l => `  ${l}`).join('\n')}

The parts it is made of, and the tag each one carries:
  ${roles.join(', ')}

Give every part an "engine_role" from that list and a "name". Give a "size"
because the schema wants one, but the shop overwrites it from the numbers
above — the crankshaft's diameter comes off the bore, not off you. Your job
here is WHICH PARTS and WHERE THEY MOUNT, nothing else.
`;
}

export function buildSpecialistMessages(roleId, order, assignment, ctx = {}) {
  const role = roleById(roleId);
  if (!role) return null;
  const n = assignment.parts || budgetOf(roleId, 3);
  const must = assignment.must?.length
    ? `\nTHE BRIEF SAYS THESE MUST EXIST: ${assignment.must.join(', ')}. Every one of them is a part you hand back.\n`
    : '';
  const reqs = order.requirements?.length
    ? `\nREQUIREMENTS THE WHOLE OBJECT HAS TO MEET\n${order.requirements.map(r => `  · ${r}`).join('\n')}\n`
    : '';
  const learned = ctx.recalled ? recalledForRole(ctx.recalled, roleId) : '';
  /* The trade that owns engines is told what the engine IS, and told that
     the sizing is already done. Everybody else is told nothing about it —
     a light-materials specialist who knows the bore is a specialist who
     starts guessing at cylinder heads. */
  const engine = roleId === 'powerplant' && ctx.engine ? engineBrief(ctx.engine) : '';

  const system = `${roleBlock(roleId)}
${engine}
You are one of several specialists working on the same object at the same time.
You cannot see the others and you must not try to. You make YOUR parts and
you bolt them to the frame at a NAMED MOUNT POINT. Everything else on this
floor is somebody else's problem and will be there when you are done.

${frameBlock(order)}
${reqs}${must}
HOW YOU SAY WHERE A PART GOES
  "mount": "${assignment.mount || order.mounts[0].id}"        bolted to that named point on the frame
  "attach": { "to": 0, "face": "top" }   bolted to one of YOUR OWN earlier parts,
                                          numbered from 0 in the order you list them

  Use "mount" for the first part of your subassembly. Use "attach" to build
  your own parts up off each other. NEVER refer to another trade's parts —
  you do not know their numbers and you would be guessing.

REPEATED PARTS — one entry, not four
  "array": { "mode": "quad", "radius": 0.4 }
    quad      four at the corners of a square
    ring      "count" evenly around the centre, each turned to face outward
    mirror_x  a matched pair left and right
    mirror_z  a matched pair front and back
    row       "count" in a line, "spacing" apart

RULES
1. Return ONLY a JSON object. No prose, no fences.
2. Exactly ${n} part${n === 1 ? '' : 's'}. Not more. If you think you need more, make the
   ones that matter and say so in "notes".
3. Materials: ${role.materials.join(', ')}. Nothing else — a part outside your
   materials belongs to another trade and will be taken off you.
4. Shapes: ${role.shapes.join(', ')}.
5. Sizes are [width, height, depth] in metres, 0.15 to 2.5, in proportion with
   the frame above. "rot" is optional, in DEGREES.
6. "say" is your own line while you make it, first person, under 12 words.
7. Vary the shapes. A trade that hands back three boxes has not thought about it.
${roleId === 'electrical' ? `
WIRING
Pin references use YOUR OWN part numbers: "0.+" is the plus pin of your part 0.
Every loop closes — out of the supply's +, through the loop, back into its −.
Every LED gets a series resistor.
` : ''}${learned}
SHAPE OF THE OUTPUT
{"notes":"one line","parts":[{"name":"${role.vocabulary[0]}","shape":"${role.shapes[0]}","material":"${role.materials[0] || 'metal'}","size":[0.4,0.3,0.4],"mount":"${assignment.mount || order.mounts[0].id}","say":"Cutting it now."}]}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: `The object: ${order.title}. ${order.summary}\n\nYour assignment: ${assignment.brief}` }
  ];
}

/* The controls specialist gets asked the only question it answers. */
export function buildControlsMessages(order, assignment, request) {
  const system = `${roleBlock('controls')}

${frameBlock(order)}

RULES
1. Return ONLY a JSON object. No prose, no fences.
2. "requirements": 3 to 6 short lines the finished object must satisfy. Each one
   has to be checkable by LOOKING at the object on the pedestal — proportions,
   clearances, what reaches the ground, what has to be able to move, what must
   not be enclosed. No software architecture, no code, no firmware.
3. "checks": 2 to 4 things the foreman should inspect at the end.
4. You produce no parts. None. Not one.

SHAPE OF THE OUTPUT
{"notes":"one line","requirements":["stands without falling over"],"checks":["shade clears the stem"]}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: `Build request: ${request}\nThe object: ${order.title}. ${order.summary}\nYour assignment: ${assignment?.brief || 'set the requirements for this build'}` }
  ];
}

/* What this trade did last time, out of a recalled whole-object recipe. Each
   specialist only ever sees its own share of it — handing the electrical
   specialist the frame's history teaches it nothing and costs tokens. */
function recalledForRole(recalled, roleId) {
  const parts = (recalled?.skill?.recipe?.parts || []).filter(p => roleForMaterial(p.material) === roleId);
  if (!parts.length) return '';
  const lines = parts.map(p => `  ${p.role || p.name}  ${p.shape} in ${p.material}  [${(p.size || []).map(n => Number(n).toFixed(2)).join(', ')}]${p.array ? `  array ${p.array.mode}` : ''}`).join('\n');
  return `
WHAT YOUR TRADE MADE LAST TIME THIS CAME UP
${lines}
That one passed inspection. Start from it, resize it to this frame, and only
restructure it if this brief is genuinely different.
`;
}

/* ------------------------------------------------------------------ */
/* clamping a specialist's reply                                       */
/* ------------------------------------------------------------------ */

/* The authority gate. A specialist's material envelope is enforced here and
   nowhere else, so there is exactly one place to look when a cardboard part
   turns up in a weldment. Out-of-envelope is coerced, not rejected — the
   part is still wanted, it is just going to be made of what this trade
   actually works in. */
export function validateSubplan(raw, roleId, order, assignment) {
  const role = roleById(roleId);
  const out = { role: roleId, notes: String(raw?.notes || '').slice(0, 160), parts: [], wires: [], coerced: 0, dropped: 0 };
  if (!role || !makesParts(roleId)) return out;

  const limit = assignment?.parts || budgetOf(roleId, 3);
  const mountIds = new Set(order.mounts.map(m => m.id));
  const fallbackMount = mountIds.has(assignment?.mount) ? assignment.mount : order.mounts[0].id;

  const src = Array.isArray(raw?.parts) ? raw.parts : [];
  for (const p of src) {
    if (out.parts.length >= limit) { out.dropped++; continue; }
    const size = Array.isArray(p?.size) ? p.size : [];
    const wantMat = String(p?.material || '').toLowerCase();
    const material = clampMaterial(roleId, wantMat);
    if (wantMat && wantMat !== material) out.coerced++;
    const wantShape = String(p?.shape || '').toLowerCase();
    const shape = clampShape(roleId, wantShape);
    if (wantShape && wantShape !== shape) out.coerced++;

    const part = {
      name: String(p?.name || role.vocabulary[0] || 'part').slice(0, 40),
      shape, material,
      size: [0, 1, 2].map(i => clamp(Number(size[i]) || 0.4, 0.15, 2.5)),
      say: String(p?.say || '').slice(0, 90) || null
    };

    const rot = Array.isArray(p?.rot) ? p.rot : null;
    if (rot && rot.slice(0, 3).every(v => Number.isFinite(Number(v)))) {
      part.rot = [0, 1, 2].map(i => clamp(Number(rot[i]), -180, 180));
    }
    const ar = validArray(p?.array);
    if (ar) part.array = ar;
    /* Carried like engine_role, and dropped for the same reason it was:
       the merge rebuilds a part from the fields it knows about, and a
       wheel that loses this tag is a wheel welded to the chassis. */
    if (MOVERS.includes(String(p?.moves || '').toLowerCase())) part.moves = String(p.moves).toLowerCase();

    /* Placement: a local attachment beats a mount, because a specialist
       building its own parts up off each other knows more about that
       relationship than the manager did. A local attachment that points
       forward or at itself is not a relationship, it is a typo. */
    const to = Math.round(Number(p?.attach?.to));
    if (Number.isInteger(to) && to >= 0 && to < out.parts.length) {
      const face = FACES.includes(String(p.attach.face || '').toLowerCase()) ? String(p.attach.face).toLowerCase() : 'top';
      part.attach = { to, face };
      for (const k of ['dx', 'dy', 'dz']) {
        const v = Number(p.attach[k]);
        if (Number.isFinite(v) && v !== 0) part.attach[k] = clamp(v, -2.5, 2.5);
      }
    } else {
      const m = slug(p?.mount);
      part.mount = mountIds.has(m) ? m : fallbackMount;
      for (const k of ['dx', 'dy', 'dz']) {
        const v = Number(p?.[k]);
        if (Number.isFinite(v) && v !== 0) part[k] = clamp(v, -2.5, 2.5);
      }
    }

    /* An electrical part takes its body from the catalogue, exactly as it
       does in validatePlan — a specialist is no more trusted about what a
       resistor looks like than the old single planner was. */
    /* Which bit of an engine this is. Kept only for the trade that owns
       engines — a light-materials part calling itself a crankshaft would
       otherwise be re-bodied in alloy on the way through validatePlan. */
    const role_e = String(p?.engine_role || '').toLowerCase();
    if (roleId === 'powerplant' && ENGINE_ROLES.includes(role_e)) part.engine_role = role_e;

    const comp = String(p?.component || '').toLowerCase();
    if (roleId === 'electrical' && isComponent(comp)) {
      const body = bodyFor(comp);
      part.component = comp;
      part.shape = body.shape; part.size = body.size.slice(); part.material = body.material;
      const v = Number(p?.value);
      part.value = Number.isFinite(v) && v > 0 ? v : COMPONENTS[comp].value;
    }
    out.parts.push(part);
  }

  /* Wires are kept in LOCAL pin space here and remapped during the merge.
     Validating them properly needs the global part list, so all this does is
     throw out anything that is not two pin references. */
  for (const w of Array.isArray(raw?.wires) ? raw.wires.slice(0, 40) : []) {
    const from = localPin(w?.from, out.parts.length);
    const to = localPin(w?.to, out.parts.length);
    if (from && to && from !== to) out.wires.push({ from, to });
  }
  return out;
}

function localPin(ref, n) {
  const m = String(ref || '').trim().match(/^(\d+)\s*[.:]\s*(.+)$/);
  if (!m) return null;
  const i = Number(m[1]);
  if (!Number.isInteger(i) || i < 0 || i >= n) return null;
  return `${i}.${m[2].trim()}`;
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

/* Controls' reply, clamped to what it is allowed to be: words. */
export function validateSpec(raw) {
  const take = (arr, n, len) => (Array.isArray(arr) ? arr : []).map(x => String(x || '').trim().slice(0, 120)).filter(Boolean).slice(0, n);
  return {
    role: 'controls',
    notes: String(raw?.notes || '').slice(0, 160),
    requirements: take(raw?.requirements, 6),
    checks: take(raw?.checks, 4),
    parts: [], wires: [], coerced: 0, dropped: 0
  };
}

/* ------------------------------------------------------------------ */
/* the merge                                                           */
/* ------------------------------------------------------------------ */

/* Frame first, then each trade's block in crew order, then the foreman fits
   it together. Every index in the finished plan points backwards, which is
   what validatePlan requires and what makes an attachment cycle impossible.

   The one thing to be careful about: a specialist's part numbers are LOCAL.
   `offset` is where that trade's block starts in the global part list, and
   every local attachment and every wire pin has to be shifted by it. This is
   the same class of bug as reindexAttachments in agent.js — it does not
   throw, it silently bolts the shade to a wheel. */
export function mergeSubplans(order, subplans, opts = {}) {
  /* The engine spec rides on the plan the way the netlist does — one
     object at the top, not a field on every part. validatePlan re-bodies
     every tagged part from it. */
  const byRole = new Map((subplans || []).map(s => [s.role, s]));
  const mounts = new Map(order.mounts.map(m => [m.id, m]));
  const steps = [];
  const wires = [];
  let global = 0;

  /* --- the controls specialist opens the job --- */
  const spec = byRole.get('controls');
  const reqs = [...(order.requirements || []), ...((spec && spec.requirements) || [])];
  steps.push({ room: 'software', action: 'boot_pc', say: 'Pulling the job up.', seconds: 3, by: 'controls' });
  steps.push({
    room: 'software', action: 'type',
    say: (spec?.requirements?.[0] && `Spec: ${spec.requirements[0]}`.slice(0, 88)) || 'Writing the spec out.',
    seconds: 4, by: 'controls'
  });
  steps.push({ room: 'software', action: 'read_screen', say: 'Numbers check out.', seconds: 3, by: 'controls' });

  /* --- the frame --- */
  order.frame.forEach((p, i) => {
    /* A frame part that is part of an engine belongs to the trade that
       makes engines, not to whoever owns the metal it happens to be cut
       from — a block is the frame of the object AND the powerplant's own
       work, and routing it by material alone hands the crankcase to
       structures. */
    const owner = p.engine_role ? 'powerplant' : roleForMaterial(p.material);
    const part = {
      name: p.name, shape: p.shape, material: p.material, size: p.size.slice()
    };
    if (p.engine_role) part.engine_role = p.engine_role;
    if (p.attach) part.attach = { ...p.attach };          // already frame-local, and the frame starts at 0
    if (p.array) part.array = { ...p.array };
    if (p.rot) part.rot = p.rot.slice();
    steps.push({
      room: stationOf(owner),
      action: actionFor(owner, i === 0 ? 'cut' : 'join'),
      say: i === 0 ? `Frame first. Cutting the ${p.name}.`.slice(0, 88) : `Fitting the ${p.name} to the frame.`.slice(0, 88),
      seconds: 4 + (i % 3),
      by: owner,
      part
    });
    global++;
  });

  /* --- each trade's block, then the foreman's own --- *
     The foreman is last on purpose: paint, glass and the fitted trim are
     his, and they go on after everything they sit on top of exists. Leave
     him out of this loop and an offline split quietly drops a lamp's shade
     on the floor, because "painted" routes to him. */
  for (const role of [...SPECIALISTS, FOREMAN]) {
    if (!makesParts(role.id)) continue;
    const sub = byRole.get(role.id);
    if (!sub || !sub.parts.length) continue;
    const offset = global;
    const kinds = ['cut', 'form', 'join', 'hole', 'finish'];

    sub.parts.forEach((p, j) => {
      const part = {
        name: p.name, shape: p.shape, material: p.material, size: p.size.slice()
      };
      if (p.rot) part.rot = p.rot.slice();
      if (p.array) part.array = { ...p.array };
      if (p.component) { part.component = p.component; part.value = p.value; }
      if (p.engine_role) part.engine_role = p.engine_role;
      if (p.moves) part.moves = p.moves;

      if (p.attach) {
        /* local → global. `to` was already checked to be an earlier part of
           this same block, so offset + to is always earlier than this one. */
        part.attach = { ...p.attach, to: offset + p.attach.to };
      } else {
        const m = mounts.get(p.mount) || order.mounts[0];
        part.attach = { to: m.on, face: m.face };
        /* the mount's own standoff first, then the part's — the part is
           the more specific statement, and it is the one that survives a
           split of a plan the shop had already built */
        for (const k of ['dx', 'dy', 'dz']) if (m[k]) part.attach[k] = m[k];
        for (const k of ['dx', 'dy', 'dz']) if (p[k]) part.attach[k] = p[k];
      }

      steps.push({
        room: role.station,
        action: actionFor(role.id, p.component ? 'join' : kinds[j % kinds.length]),
        say: (p.say || `Making the ${p.name}.`).slice(0, 88),
        seconds: 3 + (j % 4),
        by: role.id,
        part
      });
      global++;
    });

    for (const w of sub.wires) {
      wires.push({ from: shiftPin(w.from, offset), to: shiftPin(w.to, offset) });
    }
    if (sub.parts.some(p => p.component)) {
      steps.push({ room: 'electronics', action: 'meter_test', say: 'Ringing it out.', seconds: 3, by: 'electrical' });
    }
  }

  /* --- the foreman fits it together and hands it over --- */
  steps.push({ room: 'finished', action: 'assemble', say: 'Right — bringing it together.', seconds: 5, by: 'foreman' });
  const check = spec?.checks?.[0];
  steps.push({
    room: 'finished', action: 'inspect',
    say: (check ? `Checking: ${check}` : 'Squaring it up.').slice(0, 88),
    seconds: 3, by: 'foreman'
  });
  steps.push({ room: 'finished', action: 'present', say: opts.handover || 'That is the build. Over to you, Jarvis.', seconds: 4, by: 'foreman' });

  const plan = {
    title: order.title,
    summary: order.summary || (() => {
      const n = [...byRole.keys()].filter(k => byRole.get(k).parts.length).length;
      return `Built on the floor by ${n} trade${n === 1 ? '' : 's'}.`;
    })(),
    steps
  };
  if (wires.length) plan.wires = wires;
  if (opts.engine) plan.engine = opts.engine;
  if (reqs.length) plan.requirements = reqs.slice(0, 8);
  return plan;
}

function shiftPin(ref, offset) {
  const m = String(ref).match(/^(\d+)\.(.+)$/);
  return m ? `${Number(m[1]) + offset}.${m[2]}` : ref;
}

/* ------------------------------------------------------------------ */
/* what a trade makes when nobody answers for it                       */
/* ------------------------------------------------------------------ */

/* A specialist's call failing must not leave a hole in the object. This is
   deliberately dumb — it makes something plausible in the right material,
   the right rough size and bolted to the right mount — because a dumb part
   in the right place still reads, and a missing one does not.

   Sized off the frame rather than off nothing: a shade on a 2m mast and a
   shade on a 0.3m stem are not the same shade. */
export function fallbackSubplan(roleId, order, assignment, engine = null) {
  const role = roleById(roleId);
  if (!role || !makesParts(roleId)) return { role: roleId, notes: '', parts: [], wires: [], coerced: 0, dropped: 0 };

  /* The powerplant trade has a far better fallback than its own vocabulary:
     the engine is arithmetic, so a dead model costs it nothing at all. It
     hands back the real parts, mounted on the frame, and the build is the
     one it would have been. */
  if (engine && roleId === 'powerplant') {
    const mount0 = assignment?.mount || order.mounts[0].id;
    const parts = engineParts(sizeEngine(engine))
      .slice(0, assignment?.parts || budgetOf(roleId, 6))
      .map((p, i) => {
        const out = {
          name: p.name, shape: p.shape, material: clampMaterial(roleId, p.material),
          size: p.size.slice(), engine_role: p.engine_role,
          say: `${role.name} here — ${p.name}.`.slice(0, 88)
        };
        if (p.rot) out.rot = p.rot.slice();
        if (p.array) out.array = { ...p.array };
        if (i > 0 && p.attach && p.attach.to < i) out.attach = { ...p.attach };
        else out.mount = mount0;
        return out;
      });
    return { role: roleId, notes: 'sized from the engine spec — no model needed', parts, wires: [], coerced: 0, dropped: 0, fallback: true };
  }

  const n = Math.min(assignment?.parts || 2, 3);
  const base = order.frame[0]?.size || [0.8, 0.2, 0.8];
  const w = clamp(base[0] * 0.7, 0.2, 1.6);
  const names = (assignment?.must?.length ? assignment.must : role.vocabulary).slice(0, n);
  const mount = assignment?.mount || order.mounts[0].id;

  const parts = [];
  for (let i = 0; i < n; i++) {
    const shape = role.shapes[i % Math.min(3, role.shapes.length)];
    const part = {
      name: String(names[i] || role.vocabulary[i % role.vocabulary.length]).slice(0, 40),
      shape,
      material: role.materials[0],
      size: [clamp(w * (1 - i * 0.18), 0.15, 2.5), clamp(0.5 - i * 0.12, 0.15, 2.5), clamp(w * (1 - i * 0.18), 0.15, 2.5)],
      say: `${role.name} here — making the ${String(names[i] || 'part')}.`.slice(0, 88)
    };
    if (i === 0) part.mount = mount; else part.attach = { to: i - 1, face: 'top' };
    parts.push(part);
  }
  return { role: roleId, notes: 'built from the trade’s own defaults — no engine answered', parts, wires: [], coerced: 0, dropped: 0, fallback: true };
}

/* ------------------------------------------------------------------ */
/* attributing a plan that was not built by the crew                   */
/* ------------------------------------------------------------------ */

/* The offline planner, the recalled recipe and everything the bench edits
   produce plain plans with no owner on any step. The floor still has to know
   who does what, so ownership is derived: a step that makes a part belongs
   to whoever works that material, and a step that makes nothing belongs to
   whoever owns that station. Total by construction — roleForMaterial and
   roleForStation both fall through to the foreman. */
export function attributePlan(plan) {
  if (!plan?.steps) return plan;
  for (const step of plan.steps) {
    if (step.by && roleById(step.by)) continue;
    step.by = step.part
      ? (step.part.component ? 'electrical'
        : step.part.engine_role ? 'powerplant'
          : roleForMaterial(step.part.material))
      : roleForStationKey(step.room);
  }
  return plan;
}

function roleForStationKey(room) {
  const r = [...SPECIALISTS, FOREMAN].find(x => x.station === room);
  return r ? r.id : FOREMAN.id;
}

/* Who did what, for the log and for the crew panel. */
export function crewTally(plan) {
  const tally = {};
  for (const step of plan?.steps || []) {
    const id = step.by || 'foreman';
    tally[id] = tally[id] || { steps: 0, parts: 0 };
    tally[id].steps++;
    if (step.part) tally[id].parts++;
  }
  return tally;
}
