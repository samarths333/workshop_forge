/* THE WORK ORDER — what the floor manager writes before anybody picks up a
   tool.

   The old shop asked one model for the whole object in one go, and the whole
   object is exactly the thing a model is worst at: it has to hold the
   structure, the skin, the electronics and the proportions in its head at
   once, and what falls out is a heap that is roughly the right silhouette
   with the details smeared across it.

   So the floor does it the way a real shop does. The manager writes a work
   order FIRST, and the work order is deliberately small: the frame that
   everything hangs off, a handful of NAMED MOUNT POINTS on that frame, and
   one assignment per trade saying what they make and which mount it bolts
   to. Then five specialists work at the same time, each on a brief they can
   actually hold in their head, each inside their own materials.

   The mount points are the load-bearing idea. They are the interface. A
   specialist never says where its parts are in the world and never refers to
   another specialist's parts — it says "this bolts to `mast_top`", and
   crewplan.js resolves that to a real attachment once everything is back.
   That is what makes parallel work merge into one object instead of four.

   This file is pure: it builds prompts, it clamps replies, and it can be run
   under node with no window. */

import { SHAPES, MATERIALS, FACES, ARRAY_MODES } from './assembly.js';
import { SHAPE_ENUM, isShape } from './shapelib.js';
import { catalogBlock } from './catalog.js';
import {
  SPECIALISTS, SPECIALIST_IDS, ROLE_IDS, FOREMAN, roleById, formatRoster,
  budgetOf, clampMaterial, clampShape, roleForMaterial, makesParts
} from './roles.js';
import { classifyRequest, domainKnowledge, technicalBlock, readingBlock } from './library.js';
import { engineBlock, ENGINE_ROLES } from './engine.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);

/* Frames stay small on purpose. The manager's job is the skeleton and the
   interfaces, not the object — the moment a frame runs to eight parts the
   manager has quietly done the specialists' work badly. */
export const FRAME_MAX = 4;
export const MOUNT_MAX = 8;

/* ------------------------------------------------------------------ */
/* schema                                                              */
/* ------------------------------------------------------------------ */
const FRAME_PART_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    shape: { type: 'string', enum: SHAPE_ENUM },
    material: { type: 'string', enum: MATERIALS },
    size: { type: 'array', items: { type: 'number' } },
    rot: { type: 'array', items: { type: 'number' } },
    /* the frame of an engine is the block or the casing, and it is sized
       from the same numbers as everything bolted to it */
    engine_role: { type: 'string', enum: ENGINE_ROLES },
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
    }
  },
  required: ['name', 'shape', 'material', 'size']
};

export const ORDER_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    requirements: { type: 'array', items: { type: 'string' } },
    frame: { type: 'array', items: FRAME_PART_SCHEMA },
    mounts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          on: { type: 'integer' },
          face: { type: 'string', enum: FACES },
          dx: { type: 'number' }, dy: { type: 'number' }, dz: { type: 'number' },
          note: { type: 'string' }
        },
        required: ['id', 'on', 'face']
      }
    },
    assignments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: SPECIALIST_IDS },
          brief: { type: 'string' },
          mount: { type: 'string' },
          parts: { type: 'integer' },
          must: { type: 'array', items: { type: 'string' } }
        },
        required: ['role', 'brief', 'parts']
      }
    }
  },
  required: ['title', 'summary', 'frame', 'mounts', 'assignments']
};

/* ------------------------------------------------------------------ */
/* the manager's prompt                                                */
/* ------------------------------------------------------------------ */
const ORDER_RULES = `WHAT A WORK ORDER IS

You are writing three things and nothing else.

1. THE FRAME — 1 to ${FRAME_MAX} parts. The skeleton. What stands on the floor and
   what the object is fundamentally built around: the base, the chassis, the
   body tube, the mast, the deck. Part 0 has NO "attach" — it is the one that
   stands on the pedestal. Any other frame part attaches to an EARLIER frame
   part by index.

   The frame is not the object. If you find yourself putting the shade, the
   wheels, the fins or the enclosure in the frame, stop — those belong to a
   trade.

2. THE MOUNTS — up to ${MOUNT_MAX} named points on the frame where the trades bolt
   their work on. This is the whole reason five specialists can work at once.

     { "id": "mast_top", "on": 1, "face": "top", "note": "the shade goes here" }

     id    a short lower_case name. The specialists will use it by name.
     on    which FRAME part (index into your frame list)
     face  top | bottom | left | right | front | back | inside
     dx,dy,dz  optional nudge in metres

   Name a mount for every place a specialist will need to attach something.
   A trade with no mount can only bolt to the base, and everything ends up
   in a pile at the bottom.

3. THE ASSIGNMENTS — one per trade that has real work. Each says what that
   trade makes, which mount it hangs off, and roughly how many parts.

     { "role": "softgoods", "mount": "mast_top", "parts": 3,
       "brief": "the shade — a wide cone opening downward, plus its collar",
       "must": ["shade", "collar"] }

   Write the brief as if the specialist cannot see the request. It cannot see
   the other assignments either, so say what its piece IS, not what it is
   not. Never give two trades the same part.

RULES
· Return ONLY a JSON object. No prose, no fences.
· Sizes are [width, height, depth] in metres, each 0.15 to 2.5, in proportion.
· "rot" is optional, in DEGREES.
· Give work to every trade that genuinely has some, and to no trade that does
  not. A wooden stool has nothing for the electrical specialist. Do not invent
  a circuit to keep somebody busy.
· "controls" gets an assignment only when the object must DO something. Its
  "parts" is always 0 — it writes requirements, never geometry.
· Requirements: 2 to 5 short lines the finished object has to satisfy, in
  plain terms that can be checked by looking at it — "stands without falling
  over", "the shade clears the stem", "the wheels turn".`;

export function buildOrderMessages(request, refs, read, recalled, domain) {
  const d = domain || classifyRequest(request);
  const tech = d.engineering ? technicalBlock(request, refs, d.domain) : '';
  const seen = referenceStructure(refs);
  const known = recalledOrderBlock(recalled);

  const system = `${FOREMAN.description}

${formatRoster()}

${ORDER_RULES}
${catalogBlock(request)}
${seen}${tech}${readingBlock(read)}${engineBlock(request)}${known}
SHAPE OF THE OUTPUT
{"title":"...","summary":"one sentence","requirements":["stands on its own"],"frame":[{"name":"base","shape":"cylinder","material":"metal","size":[0.5,0.12,0.5]}],"mounts":[{"id":"base_top","on":0,"face":"top","note":"the stem goes here"}],"assignments":[{"role":"structures","mount":"base_top","parts":2,"brief":"the stem and its collar","must":["stem"]}]}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: `Build request: ${request}\n\nWrite the work order.` }
  ];
}

/* What people who make this thing call its parts. The manager gets the
   vocabulary rather than the titles — it is naming mounts, and a mount named
   after somebody's Thingiverse listing is worse than one named "top". */
function referenceStructure(refs) {
  const words = new Set();
  for (const r of refs || []) for (const s of r.structure || []) words.add(s);
  if (!words.size) return '';
  return `
WHAT A REAL ONE IS MADE OF
People who have actually built this call its parts: ${[...words].slice(0, 24).join(', ')}.
Use those words for your mounts and in your briefs. If most real ones have a
part, some trade on this floor should be told to make it.
`;
}

/* A recalled skill is a whole finished object. To the manager it is worth
   exactly one thing: the shape of the decomposition that worked last time. */
function recalledOrderBlock(recalled) {
  const s = recalled?.skill;
  if (!s?.recipe?.parts?.length) return '';
  const byRole = {};
  for (const p of s.recipe.parts) {
    const r = roleForMaterial(p.material);
    (byRole[r] = byRole[r] || []).push(p.role || p.name);
  }
  const lines = Object.entries(byRole).map(([r, names]) => `  ${r}: ${names.join(', ')}`).join('\n');
  return `
THE FLOOR HAS BUILT THIS BEFORE
"${s.name}" came out right ${s.stats?.uses || 1} time(s), split up like this:
${lines}
Start from that split. Change it where this request is genuinely different.
`;
}

/* ------------------------------------------------------------------ */
/* clamping the manager's reply                                        */
/* ------------------------------------------------------------------ */

/* Same contract as validatePlan: the prompt is guidance, this is the rule.
   A work order that gets past here is guaranteed to be mergeable — every
   frame attachment points backwards, every mount lands on a frame part that
   exists, every assignment names a real trade at most once, and nobody is
   over budget. crewplan.js is allowed to assume all of that. */
export function validateOrder(raw, request = '') {
  const out = {
    title: String(raw?.title || request || 'Shop build').slice(0, 80),
    summary: String(raw?.summary || '').slice(0, 240),
    requirements: [],
    frame: [],
    mounts: [],
    assignments: []
  };

  for (const r of Array.isArray(raw?.requirements) ? raw.requirements : []) {
    const s = String(r || '').trim().slice(0, 120);
    if (s) out.requirements.push(s);
    if (out.requirements.length >= 6) break;
  }

  /* ---- the frame ---- */
  const frame = Array.isArray(raw?.frame) ? raw.frame : [];
  for (const p of frame) {
    const size = Array.isArray(p?.size) ? p.size : [];
    const part = {
      name: String(p?.name || 'frame part').slice(0, 40),
      shape: isShape(p?.shape) ? String(p.shape).toLowerCase() : 'box',
      material: MATERIALS.includes(String(p?.material).toLowerCase()) ? String(p.material).toLowerCase() : 'metal',
      size: [0, 1, 2].map(i => clamp(Number(size[i]) || 0.4, 0.15, 2.5))
    };
    const at = validAttach(p?.attach, out.frame.length);
    if (at) part.attach = at;
    const ar = validArray(p?.array);
    if (ar) part.array = ar;
    const eRole = String(p?.engine_role || '').toLowerCase();
    if (ENGINE_ROLES.includes(eRole)) part.engine_role = eRole;
    const rot = Array.isArray(p?.rot) ? p.rot : null;
    if (rot && rot.slice(0, 3).every(v => Number.isFinite(Number(v)))) {
      part.rot = [0, 1, 2].map(i => (clamp(Number(rot[i]), -180, 180) * Math.PI) / 180);
    }
    out.frame.push(part);
    if (out.frame.length >= FRAME_MAX) break;
  }
  /* A work order with no frame has no interfaces, and every trade would come
     back with parts attached to nothing. One box is a worse frame than a
     thought-out one and a far better frame than none. */
  if (!out.frame.length) {
    out.frame.push({ name: 'base', shape: 'panel', material: 'metal', size: [0.9, 0.1, 0.7] });
  }
  /* Part 0 stands on the pedestal, always. A frame whose first part is
     attached to something has nothing holding it up. */
  delete out.frame[0].attach;

  /* ---- the mounts ---- */
  const seen = new Set();
  for (const m of Array.isArray(raw?.mounts) ? raw.mounts : []) {
    const id = slug(m?.id);
    if (!id || seen.has(id)) continue;
    const on = Math.round(Number(m?.on));
    if (!Number.isInteger(on) || on < 0 || on >= out.frame.length) continue;
    const face = FACES.includes(String(m?.face || '').toLowerCase()) ? String(m.face).toLowerCase() : 'top';
    const mount = { id, on, face };
    for (const k of ['dx', 'dy', 'dz']) {
      const v = Number(m?.[k]);
      if (Number.isFinite(v) && v !== 0) mount[k] = clamp(v, -2.5, 2.5);
    }
    if (m?.note) mount.note = String(m.note).slice(0, 90);
    seen.add(id);
    out.mounts.push(mount);
    if (out.mounts.length >= MOUNT_MAX) break;
  }
  /* Every order gets a mount on the top and the side of the base whether the
     manager thought of it or not, because a specialist with no reachable
     mount can only be dropped on the floor. */
  if (!seen.has('base_top')) out.mounts.unshift({ id: 'base_top', on: 0, face: 'top', note: 'the top of the frame' });
  if (!seen.has('base_side')) out.mounts.push({ id: 'base_side', on: 0, face: 'left', note: 'the side of the frame' });

  /* ---- the assignments ---- */
  const taken = new Set();
  for (const a of Array.isArray(raw?.assignments) ? raw.assignments : []) {
    /* The model only ever sees the specialists in its schema, but the
       foreman is allowed an assignment here: he does the paint, the glass
       and the final fit, and an offline split hands him those parts by
       material. Refusing them would drop a lamp's shade on the floor. */
    const role = String(a?.role || '').toLowerCase();
    if (!ROLE_IDS.includes(role) || taken.has(role)) continue;
    taken.add(role);
    const mount = slug(a?.mount);
    out.assignments.push({
      role,
      brief: String(a?.brief || '').slice(0, 300) || `whatever a ${role} would contribute to a ${out.title}`,
      mount: out.mounts.some(m => m.id === mount) ? mount : out.mounts[0].id,
      parts: makesParts(role) ? budgetOf(role, a?.parts) : 0,
      must: (Array.isArray(a?.must) ? a.must : []).map(x => String(x).slice(0, 40)).filter(Boolean).slice(0, 6)
    });
  }
  /* An order that gave nobody any work is an order for a frame, which is not
     an object. Structures always has something to do — it owns the frame. */
  if (!out.assignments.some(a => a.parts > 0)) {
    out.assignments.push({
      role: 'structures',
      brief: `the parts that make this read as a ${out.title} — bolted to the frame`,
      mount: out.mounts[0].id,
      parts: budgetOf('structures', 3),
      must: []
    });
  }
  return out;
}

function validAttach(raw, ownIndex) {
  if (!raw || typeof raw !== 'object') return null;
  const to = Math.round(Number(raw.to));
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

/* ------------------------------------------------------------------ */
/* the order the floor writes for itself                               */
/* ------------------------------------------------------------------ */

/* No engine, or the manager's call failed. The floor still has to work, so
   the decomposition is done from a plan the offline planner already knows
   how to produce: take its parts, put the ones that stand up in the frame,
   and hand the rest out by material. It is cruder than a manager who can
   think, and it is a real decomposition — every trade still gets its own
   brief and still works to a mount. */
export function orderFromParts(parts, title, summary = '') {
  const src = (parts || []).filter(Boolean);
  const order = { title: String(title || 'Shop build').slice(0, 80), summary: String(summary).slice(0, 240), requirements: [], frame: [], mounts: [], assignments: [] };
  if (!src.length) return validateOrder(order, title);

  /* The frame is the root part plus anything bolted straight to it that is
     structural — that is the skeleton by definition, and it is what the
     mounts have to be able to reach. */
  const frameIdx = [];
  src.forEach((p, i) => {
    if (frameIdx.length >= FRAME_MAX) return;
    /* An engine part is never the frame. The block is the root of its own
       subassembly, not the shop's — hand it to the frame and the powerplant
       trade is left mounting cylinders onto a mount point instead of onto
       the block they bolt to. */
    const structural = !p.engine_role && (roleForMaterial(p.material) === 'structures' || !p.attach);
    const rooted = !p.attach || frameIdx.includes(p.attach.to);
    if (structural && rooted) frameIdx.push(i);
  });
  if (!frameIdx.length) frameIdx.push(0);

  const frameAt = new Map(frameIdx.map((src, i) => [src, i]));
  for (const i of frameIdx) {
    const p = src[i];
    const part = { name: p.name || p.role || 'frame part', shape: p.shape || 'box', material: p.material || 'metal', size: (p.size || [0.5, 0.5, 0.5]).slice() };
    if (p.engine_role) part.engine_role = p.engine_role;
    if (p.moves) part.moves = p.moves;
    if (p.attach && frameAt.has(p.attach.to)) part.attach = { ...p.attach, to: frameAt.get(p.attach.to) };
    if (p.array) part.array = { ...p.array };
    if (p.rot) part.rot = p.rot.slice();
    order.frame.push(part);
  }

  /* One mount per frame part, so every trade has somewhere sensible to go. */
  order.frame.forEach((p, i) => {
    order.mounts.push({ id: slug(`${p.name}_top`) || `frame_${i}_top`, on: i, face: 'top', note: `on top of the ${p.name}` });
  });

  /* Everything the frame did not take is somebody's job. */
  const rest = src.map((p, i) => ({ p, i })).filter(({ i }) => !frameAt.has(i));
  const byRole = {};
  for (const { p } of rest) {
    const r = roleForMaterial(p.material);
    (byRole[r] = byRole[r] || []).push(p.name || p.role || p.shape);
  }
  for (const [role, names] of Object.entries(byRole)) {
    if (!makesParts(role)) continue;
    order.assignments.push({
      role,
      brief: `${names.slice(0, 6).join(', ')} — the ${roleById(role)?.trade.toLowerCase()} side of a ${order.title}`,
      mount: order.mounts[0].id,
      parts: budgetOf(role, names.length),
      must: names.slice(0, 4)
    });
  }
  return validateOrder(order, title);
}

/* ------------------------------------------------------------------ */
/* splitting a finished plan across the trades                          */
/* ------------------------------------------------------------------ */

/* orderFromParts gives the floor a frame and a set of briefs. What it does
   NOT do on its own is give each trade the actual parts — and with no engine
   reachable, a trade left to its own defaults hands back a generic barrel
   with the right name on it. That would make an offline build markedly worse
   than it used to be, which is not a trade anybody would take.

   So this splits the real parts list up instead. Every non-frame part goes to
   whoever works that material, keeps its own geometry, and gets its placement
   rewritten into the two things a specialist is allowed to say:

     · bolted to a mount on the frame   — when its parent is a frame part
     · bolted to one of its own parts    — when its parent is in the same block

   The third case is the interesting one: a part whose parent belongs to a
   DIFFERENT trade. A specialist cannot express that — it does not know the
   other trade's numbering, which is the whole reason the mount system exists.
   So the chain is walked up to the first frame ancestor and the part is hung
   off that instead. The solver then settles it onto whatever is underneath,
   which is what it does for everything else. */
export function splitPlan(parts, title, summary = '') {
  const src = (parts || []).filter(Boolean);
  const order = orderFromParts(src, title, summary);
  if (!src.length) return { order, subplans: [] };

  /* which source indices ended up in the frame, in frame order */
  const frameAt = new Map();
  {
    const used = new Set();
    for (const fp of order.frame) {
      const i = src.findIndex((p, k) => !used.has(k)
        && (p.name || p.role || 'frame part') === fp.name && p.shape === fp.shape);
      if (i >= 0) { used.add(i); frameAt.set(i, frameAt.size); }
    }
    // anything the name match missed: fall back to source order
    for (let i = 0; i < src.length && frameAt.size < order.frame.length; i++) {
      if (!frameAt.has(i) && !used.has(i)) { used.add(i); frameAt.set(i, frameAt.size); }
    }
  }

  /* Who a part belongs to when nobody said. A component is electrical
     whatever it is made of and a part of an engine is the powerplant
     trade's whatever it is made of — a crankshaft is steel, and routing it
     to structures on that basis would put the rotating assembly in the
     hands of the trade that makes things stand still. Material decides the
     rest. */
  const ownerOf = p => (p.component ? 'electrical' : p.engine_role ? 'powerplant' : roleForMaterial(p.material));
  const blocks = new Map();                        // role → { parts, localOf }
  const localOf = new Map();                       // source index → { role, local }

  /* the mount for a given frame part and face, created on demand — the
     default order only names the tops, and a wheel hung off the left of a
     chassis needs the left */
  const mountFor = (frameIdx, face) => {
    const found = order.mounts.find(m => m.on === frameIdx && m.face === face);
    if (found) return found.id;
    const id = slug(`${order.frame[frameIdx]?.name || 'frame'}_${face}`) || `f${frameIdx}_${face}`;
    if (!order.mounts.some(m => m.id === id) && order.mounts.length < MOUNT_MAX + 4) {
      order.mounts.push({ id, on: frameIdx, face });
      return id;
    }
    return order.mounts[0].id;
  };

  /* walk up to the first ancestor that is in the frame */
  const frameAncestor = (i, guard = 0) => {
    const p = src[i];
    if (!p?.attach || guard > 12) return null;
    const parent = p.attach.to;
    if (frameAt.has(parent)) return { on: frameAt.get(parent), face: p.attach.face };
    const up = frameAncestor(parent, guard + 1);
    return up ? { on: up.on, face: p.attach.face } : null;
  };

  src.forEach((p, i) => {
    if (frameAt.has(i)) return;
    const role = ownerOf(p);
    if (!makesParts(role)) return;
    if (!blocks.has(role)) blocks.set(role, []);
    const block = blocks.get(role);

    const part = {
      name: p.name || p.role || p.shape || 'part',
      shape: p.shape, material: p.material,
      size: (p.size || [0.4, 0.4, 0.4]).slice(),
      say: null
    };
    if (p.rot) part.rot = p.rot.map(v => (Math.abs(v) <= Math.PI * 2 ? (v * 180) / Math.PI : v));
    if (p.array) part.array = { ...p.array };
    if (p.component) { part.component = p.component; part.value = p.value; }
    if (p.engine_role) part.engine_role = p.engine_role;
    if (p.moves) part.moves = p.moves;

    const parent = p.attach?.to;
    const sibling = parent != null ? localOf.get(parent) : null;
    if (sibling && sibling.role === role) {
      part.attach = { to: sibling.local, face: p.attach.face };
      for (const k of ['dx', 'dy', 'dz']) if (p.attach[k]) part.attach[k] = p.attach[k];
    } else if (parent != null && frameAt.has(parent)) {
      part.mount = mountFor(frameAt.get(parent), p.attach.face);
    } else {
      const up = parent != null ? frameAncestor(i) : null;
      part.mount = up ? mountFor(up.on, up.face) : mountFor(0, 'top');
    }
    /* A standoff is part of the placement, not decoration on it. Onto a
       mount it used to be dropped here, and an offline split then put the
       sump flat against the block and the engine on its crankshaft. */
    if (part.mount && p.attach) {
      for (const k of ['dx', 'dy', 'dz']) if (p.attach[k]) part[k] = p.attach[k];
    }

    localOf.set(i, { role, local: block.length });
    block.push(part);
  });

  /* the wires come with the electrical block, renumbered into its own local
     pin space — the merge shifts them back out again */
  const subplans = [];
  for (const [role, list] of blocks) {
    subplans.push({ role, notes: 'split from the plan the shop already knew', parts: list, wires: [], coerced: 0, dropped: 0 });
  }

  /* the briefs on the order have to match what was actually handed out, or
     the crew panel says one thing and the floor does another */
  /* The count goes through budgetOf even though these parts already exist
     and are already good. gateAssignment refuses an assignment over a
     trade's budget, and it is right to — but it cannot tell a model asking
     for twelve parts from the shop handing over a plan it has already
     built. An unclamped number here gets the whole trade DENIED and its
     work silently disappears out of the merge. */
  order.assignments = subplans.map(sub => ({
    role: sub.role,
    brief: `${sub.parts.slice(0, 5).map(p => p.name).join(', ')} — the ${roleById(sub.role)?.trade.toLowerCase()} side of a ${order.title}`,
    mount: sub.parts[0]?.mount || order.mounts[0].id,
    parts: budgetOf(sub.role, sub.parts.length),
    must: sub.parts.slice(0, 4).map(p => p.name)
  }));
  /* No leftovers means the frame IS the object — a stool is a top and four
     legs and nothing else. validateOrder invents an assignment when a model
     gave nobody work, because an order with no work is a mistake; a SPLIT
     with no leftovers is not a mistake, and inventing two generic parts here
     would put a barrel on top of the stool. */

  return { order, subplans, localOf };
}

/* A short human line describing what the manager decided, for the log. */
export function describeOrder(order) {
  const trades = order.assignments.filter(a => a.parts > 0).map(a => `${roleById(a.role)?.name || a.role} ×${a.parts}`);
  return `frame of ${order.frame.length} · ${order.mounts.length} mount${order.mounts.length === 1 ? '' : 's'} · ${trades.length ? trades.join(', ') : 'nobody assigned'}`;
}

/* What the manager expects a real one to have, for the inspection at the
   end. Kept here rather than in the critic because it is the ORDER that is
   being checked against, not the request. */
export function orderExpectations(order, request) {
  const want = new Set();
  for (const a of order.assignments) for (const m of a.must) want.add(String(m).toLowerCase());
  const k = domainKnowledge(classifyRequest(request).domain);
  if (k) for (const p of k.parts) want.add(String(p).toLowerCase());
  return [...want];
}

export { clampMaterial, clampShape };
