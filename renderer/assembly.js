/* =====================================================================
   The assembly solver.

   The LLM is good at saying "a lamp is a wide base, a thin stem, and a
   cone shade on top, and there are four legs". It is bad at arithmetic,
   which is why asking it for exact centre coordinates produced floating
   slabs. So it no longer has to do the arithmetic.

   A part may now say where it BELONGS rather than where it IS:

     attach: { to: <index of another part>, face: 'top', dx: 0.3 }
     array:  { mode: 'ring', count: 4, radius: 0.45 }

   and this file turns that into real transforms:

     1 · expand arrays        one "leg" becomes four legs, one "fin" becomes
                              three fins standing off the body at 120°
     2 · resolve attachments  walk the parent tree, park each child on the
                              named face of its parent
     3 · settle               anything unsupported falls until it lands on
                              something. Nothing floats, ever, regardless of
                              what the model claimed.
     4 · separate             parts driven into each other get pushed apart
                              along their shallowest axis, then re-settled
     5 · joints               every real contact patch becomes a weld bead,
                              a glue fillet or a pair of bolts

   Deliberately free of any three.js import: this is arithmetic, and it runs
   in node under test/solver.test.js with no renderer at all.
   ===================================================================== */

export const SHAPES = ['box', 'panel', 'cylinder', 'rod', 'cone', 'sphere', 'torus', 'wedge', 'gear'];
export const MATERIALS = ['cardboard', 'metal', 'alloy', 'painted', 'plastic', 'glass', 'wood'];
export const FACES = ['top', 'bottom', 'left', 'right', 'front', 'back', 'inside'];
export const ARRAY_MODES = ['none', 'ring', 'mirror_x', 'mirror_z', 'quad', 'row'];

/* Pedestal top is 1.9m square; let a build overhang a little but not spill. */
const FIT_SPAN = 2.3, FIT_HEIGHT = 3.0;

/* Smallest contact patch that counts as one part holding another up —
   about 4cm square. A table leg at the very corner of a top only just
   overlaps it, and that is still a table. */
const CONTACT_AREA = 0.0015;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

/* ------------------------------------------------------------------ */
/* the box a shape really occupies                                     */
/* ------------------------------------------------------------------ */
/* Mirror of world.js partGeometry — a "rod" asked for 0.4 wide is drawn a
   third that thick, a "panel" is a sheet not a slab. The solver has to
   reason about what gets drawn, not what was asked for. Keep in step. */
export function effectiveSize(shape, size) {
  const [a, b, c] = size;
  switch ((shape || 'box').toLowerCase()) {
    /* A panel is a sheet. Which axis is thin depends on what the model
       meant: [1.2, 0.08, 0.9] is already a tabletop and should be left
       alone, while [0.9, 0.5, 0.6] is a slab that wants flattening. Always
       thinning the depth turned every tabletop into a standing sheet. */
    case 'panel': case 'plate': {
      const m = Math.min(a, b, c), M = Math.max(a, b, c);
      if (m <= M * 0.2) return [a, b, c];
      const t = Math.max(0.04, M * 0.1);
      return [a === m ? t : a, b === m ? t : b, c === m ? t : c];
    }
    case 'rod': case 'bar':     return [Math.max(0.1, a / 3), b, Math.max(0.1, a / 3)];
    case 'cylinder': case 'tube': case 'cone': case 'gear': return [a, b, a];
    case 'sphere': case 'ball': return [a, a, a];
    case 'torus': case 'ring':  return torusDims(size).size;
    default: return [a, b, c];
  }
}

/* A ring is described as [outer diameter, thickness, -] and is drawn lying
   flat, thin through its axis. Both the solver and the mesh read these
   numbers from here, because "how wide is a torus" has two plausible
   answers and picking a different one in each file puts every wheel in
   the wrong place. Stand one on its side with rot [0,0,90] for a wheel. */
export function torusDims(size) {
  const a = Math.max(0.1, size[0]);
  const tube = Math.max(0.03, Math.min((size[1] || 0.1) / 2, a * 0.24));
  const radius = Math.max(0.02, a / 2 - tube);
  const across = 2 * (radius + tube);
  return { tube, radius, size: [across, 2 * tube, across] };
}

/* ------------------------------------------------------------------ */
/* rotated axis-aligned bounds                                         */
/* ------------------------------------------------------------------ */
/* A leg splayed 20° or a fin laid on its side occupies a different box
   than its size implies. Euler XYZ, matching three.js' default order. */
function eulerMatrix([rx, ry, rz]) {
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);
  return [
    [cy * cz, -cy * sz, sy],
    [cx * sz + sx * sy * cz, cx * cz - sx * sy * sz, -sx * cy],
    [sx * sz - cx * sy * cz, sx * cz + cx * sy * sz, cx * cy]
  ];
}

/* The bounds of the SHAPE, not the bounds of the shape's box.

   Rotating the box a shape happens to fit inside is the lazy answer and it
   is wrong in a way you can see: spin a cone about its own axis and the
   box grows by up to 41%, so the solver shoves its neighbours away from a
   part that has not actually moved. A ball turned any direction is the
   same ball. Anything round about its local +Y — cylinder, rod, cone,
   torus, gear — only spreads by its radius across that axis, whatever it
   is turned to. Only genuine boxes get the rotated-box treatment. */
export function halfExtents(shape, size, rot) {
  const kind = (shape || 'box').toLowerCase();
  const [w, h, d] = effectiveSize(shape, size);
  const hx = w / 2, hy = h / 2, hz = d / 2;
  if (!rot || (!rot[0] && !rot[1] && !rot[2])) return [hx, hy, hz];

  const m = eulerMatrix(rot);
  // the shape's local +Y after rotation — the axis round things spin about
  const axis = [m[0][1], m[1][1], m[2][1]];
  const across = i => Math.sqrt(Math.max(0, 1 - axis[i] * axis[i]));

  switch (kind) {
    case 'sphere': case 'ball':
      return [hx, hx, hx];

    case 'cylinder': case 'tube': case 'rod': case 'bar': case 'gear': {
      const r = Math.max(hx, hz);
      return [0, 1, 2].map(i => Math.abs(axis[i]) * hy + r * across(i));
    }

    case 'cone': {
      // apex one end, a disc the other — and the result has to stay
      // symmetric about the origin because that is what the solver places
      const r = Math.max(hx, hz);
      return [0, 1, 2].map(i => Math.max(
        Math.abs(axis[i] * hy),
        Math.abs(axis[i] * hy) + r * across(i)
      ));
    }

    case 'torus': case 'ring': {
      const { radius, tube } = torusDims(size);
      return [0, 1, 2].map(i => radius * across(i) + tube);
    }

    default:
      return [
        Math.abs(m[0][0]) * hx + Math.abs(m[0][1]) * hy + Math.abs(m[0][2]) * hz,
        Math.abs(m[1][0]) * hx + Math.abs(m[1][1]) * hy + Math.abs(m[1][2]) * hz,
        Math.abs(m[2][0]) * hx + Math.abs(m[2][1]) * hy + Math.abs(m[2][2]) * hz
      ];
  }
}

const lo = (inst, ax) => inst.pos[ax] - inst.half[ax];
const hi = (inst, ax) => inst.pos[ax] + inst.half[ax];
const span1 = (aLo, aHi, bLo, bHi) => Math.max(0, Math.min(aHi, bHi) - Math.max(aLo, bLo));
const overlapAxis = (a, b, ax) => span1(lo(a, ax), hi(a, ax), lo(b, ax), hi(b, ax));
const footprint = (a, b) => overlapAxis(a, b, 0) * overlapAxis(a, b, 2);

/* ------------------------------------------------------------------ */
/* 1 · expansion                                                       */
/* ------------------------------------------------------------------ */
/* One part definition can stand for a set of identical parts. This is the
   single biggest fix for "it doesn't look like the thing": models reliably
   forget the second, third and fourth leg, but they never forget to say
   "four legs" if you give them somewhere to say it. */
function expand(part, idx) {
  const a = part.array;
  const base = { ...part, group: idx, ofGroup: 1, indexInGroup: 0 };
  if (!a) return [base];

  const mode = String(a.mode || 'none').toLowerCase();
  const count = clamp(Math.round(num(a.count, 1)), 1, 8);
  const radius = clamp(num(a.radius, 0.4), 0.05, 2.0);
  const spacing = clamp(num(a.spacing, 0.4), 0.05, 2.0);
  if (mode === 'none' || count < 2) return [base];

  const out = [];
  const ring = mode === 'ring';
  const mirror = mode === 'mirror_x' ? 'x' : mode === 'mirror_z' ? 'z' : null;
  const mk = (dx, dz, spin) => {
    const rot = (part.rot || [0, 0, 0]).slice();
    if (spin) rot[1] = (rot[1] || 0) + spin;
    out.push({ ...part, rot, offset: [dx, 0, dz], ring, mirror, group: idx, ofGroup: count, indexInGroup: out.length });
  };

  switch (mode) {
    case 'ring':
      for (let i = 0; i < count; i++) {
        const t = (i / count) * Math.PI * 2;
        mk(Math.sin(t) * radius, Math.cos(t) * radius, t);
      }
      break;
    case 'quad':
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) mk(sx * radius, sz * radius, 0);
      break;
    case 'mirror_x':
      mk(-radius, 0, 0); mk(radius, 0, 0);
      break;
    case 'mirror_z':
      mk(0, -radius, 0); mk(0, radius, 0);
      break;
    case 'row':
      for (let i = 0; i < count; i++) mk((i - (count - 1) / 2) * spacing, 0, 0);
      break;
    default:
      return [base];
  }
  return out.length ? out : [base];
}

/* ------------------------------------------------------------------ */
/* 2 · attachment                                                      */
/* ------------------------------------------------------------------ */
const OPPOSITE = { left: 'right', right: 'left', front: 'back', back: 'front' };

function placeOnParent(inst, parent) {
  const at = inst.attach || {};
  let face = FACES.includes(String(at.face || '').toLowerCase()) ? String(at.face).toLowerCase() : 'top';

  /* The nudges are plain world-axis offsets, applied AFTER the face has
     decided where the part sits. They used to be folded into the placement
     and then thrown away again on any face whose normal they ran along —
     which is why "nudge X" did nothing to anything bolted to a left or
     right face. */
  const nudge = [
    clamp(num(at.dx, 0), -3, 3),
    clamp(num(at.dy, 0), -3, 3),
    clamp(num(at.dz, 0), -3, 3)
  ];

  const ox = inst.offset ? inst.offset[0] : 0;
  const oz = inst.offset ? inst.offset[2] : 0;
  const [px, py, pz] = parent.pos;
  const ph = parent.half, ih = inst.half;
  let pos, fixed = true;

  /* A ring array is radial by nature — fins around a body, spokes around a
     hub — so the face only tells us it hangs off the side. Each one goes
     out along its own bearing instead of stacking on the same face. */
  if (inst.ring && face !== 'top' && face !== 'bottom') {
    const len = Math.hypot(ox, oz) || 1;
    const reach = Math.max(ph[0], ph[2]) + Math.max(ih[0], ih[2]) * 0.55;
    pos = [px + (ox / len) * reach, py, pz + (oz / len) * reach];
  } else {
    /* A mirrored pair on a side face means one each side. Saying "arms,
       mirror_x, attached to the left" and getting both arms in the same
       place was never what anyone meant. */
    if (inst.mirror === 'x' && (face === 'left' || face === 'right')) {
      face = inst.indexInGroup === 0 ? 'left' : 'right';
    } else if (inst.mirror === 'z' && (face === 'front' || face === 'back')) {
      face = inst.indexInGroup === 0 ? 'back' : 'front';
    }

    /* A paired RING on a top or bottom face has already had its direction
       expressed by which parent it landed on — a propeller on motor three
       is out at motor three. Adding the ring's own radius on top of that
       walks it a second radius further out every level, so a drone came
       out with its props orbiting outside its own motors. On a SIDE face
       the offset is a bearing rather than a translation and is kept. */
    const rx = inst.paired && inst.ring ? 0 : ox;
    const rz = inst.paired && inst.ring ? 0 : oz;

    switch (face) {
      case 'top':    pos = [px + rx, py + ph[1] + ih[1], pz + rz]; fixed = false; break;
      case 'bottom': pos = [px + rx, py - ph[1] - ih[1], pz + rz]; break;
      case 'left':   pos = [px - ph[0] - ih[0], py, pz + oz]; break;
      case 'right':  pos = [px + ph[0] + ih[0], py, pz + oz]; break;
      case 'front':  pos = [px + ox, py, pz + ph[2] + ih[2]]; break;
      case 'back':   pos = [px + ox, py, pz - ph[2] - ih[2]]; break;
      default:       pos = [px + ox, py, pz + oz]; break;          // inside
    }
  }

  inst.pos = [pos[0] + nudge[0], pos[1] + nudge[1], pos[2] + nudge[2]];
  // a deliberate vertical nudge is a standoff, and gravity must not undo it
  // the moment it is set — otherwise the field looks broken
  inst.fixed = fixed || nudge[1] !== 0;
  inst.parent = parent.i;
  inst.face = face;
}

/* ------------------------------------------------------------------ */
/* solve                                                               */
/* ------------------------------------------------------------------ */
/* parts: the plan's part specs in order. Returns placed instances in the
   pedestal frame — origin at the centre of the pedestal's top surface,
   +y up — which is exactly the frame the prompt describes. */
export function solveAssembly(parts) {
  const notes = [];
  const insts = [];

  parts.forEach((p, i) => {
    for (const e of expand(p, i)) {
      const rot = (e.rot || [0, 0, 0]).map(v => num(v, 0));
      const size = (Array.isArray(e.size) ? e.size : [0.4, 0.4, 0.4])
        .slice(0, 3).map(v => clamp(num(v, 0.4), 0.08, 2.6));
      while (size.length < 3) size.push(0.4);
      insts.push({
        i: insts.length,
        src: i,                                   // which part spec made it
        name: e.name || e.shape || 'part',
        shape: e.shape || 'box',
        material: e.material || 'cardboard',
        // carried through untouched: the mechanical solver has no opinion
        // about electronics, it just must not lose the label the wiring
        // and the bench both key off
        component: e.component || null,
        value: e.value ?? null,
        color: e.color || null,
        size, rot,
        half: halfExtents(e.shape, size, rot),
        attach: e.attach || null,
        offset: e.offset || null,
        ring: !!e.ring,
        mirror: e.mirror || null,
        at: Array.isArray(e.at) ? e.at.slice(0, 3).map(v => num(v, 0)) : null,
        pos: [0, 0, 0],
        fixed: false,
        parent: null,
        group: e.group,
        ofGroup: e.ofGroup || 1,
        indexInGroup: e.indexInGroup || 0
      });
    }
  });
  if (!insts.length) return { instances: [], joints: [], fit: 1, bounds: null, notes: ['nothing to place'] };

  /* map "part spec index" (what the model counts in) to its instances */
  const bySrc = new Map();
  for (const inst of insts) {
    if (!bySrc.has(inst.src)) bySrc.set(inst.src, []);
    bySrc.get(inst.src).push(inst);
  }

  /* -- 2 · resolve attachments, parents before children -------------- */
  const done = new Set();
  const seed = inst => {
    // no parent: use the stated centre, or drop it on the pedestal
    if (inst.at) inst.pos = inst.at.slice();
    else inst.pos = [inst.offset ? inst.offset[0] : 0, inst.half[1], inst.offset ? inst.offset[2] : 0];
    if (inst.offset && inst.at) {
      inst.pos[0] += inst.offset[0];
      inst.pos[2] += inst.offset[2];
    }
    done.add(inst.i);
  };

  let guard = 0;
  let pending = insts.slice();
  while (pending.length && guard++ < 24) {
    const next = [];
    for (const inst of pending) {
      const a = inst.attach;
      const to = a ? Math.round(num(a.to, -1)) : -1;
      if (!a || to < 0 || to === inst.src || !bySrc.has(to)) { seed(inst); continue; }
      // attach to the matching sibling in an arrayed parent when the counts
      // line up (wheel i on hub i), otherwise to the parent's first instance
      const family = bySrc.get(to);
      const paired = family.length === inst.ofGroup && inst.ofGroup > 1;
      const parent = paired ? family[inst.indexInGroup] : family[0];
      if (!done.has(parent.i)) { next.push(inst); continue; }
      /* Paired one-to-one, the child's own spread is ALREADY expressed by
         which parent it landed on — piston i is on cylinder i, and cylinder
         i is where the spacing put it. Applying the row offset on top of
         that spreads the children at twice the pitch, which walks the
         outer ones clean out of the parts they live in. A ring keeps its
         offset: there the direction is what says which way it faces. */
      if (paired && !inst.ring) inst.offset = [0, 0, 0];
      inst.paired = paired;
      placeOnParent(inst, parent);
      done.add(inst.i);
    }
    if (next.length === pending.length) { next.forEach(seed); break; }   // cycle
    pending = next;
  }

  /* -- 2b · stand the whole thing on the pedestal --------------------
     Legs hang off the UNDERSIDE of a tabletop, so resolving attachments
     puts them below zero and the top at zero. Lifting the assembly until
     its lowest point touches the pedestal is what turns that into a table
     rather than a plank lying on the floor with legs buried under it. */
  let minBottom = Infinity;
  for (const inst of insts) minBottom = Math.min(minBottom, inst.pos[1] - inst.half[1]);
  if (minBottom < -0.001) {
    for (const inst of insts) inst.pos[1] -= minBottom;
  }

  /* -- 3 · settle ---------------------------------------------------- */
  for (let pass = 0; pass < 4; pass++) settle(insts, notes, pass === 0);

  /* -- 4 · separate, then settle again ------------------------------- */
  for (let pass = 0; pass < 3; pass++) {
    if (!separate(insts)) break;
    settle(insts, notes, false);
  }

  /* -- fit on the pedestal ------------------------------------------- */
  const b = bounds(insts);
  const span = Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2]);
  const height = b.max[1];
  let fit = Math.min(1, FIT_SPAN / Math.max(0.001, span), FIT_HEIGHT / Math.max(0.001, height));
  fit = clamp(fit, 0.35, 1);
  const cx = (b.max[0] + b.min[0]) / 2, cz = (b.max[2] + b.min[2]) / 2;
  for (const inst of insts) {
    inst.pos[0] = (inst.pos[0] - cx) * fit;
    inst.pos[1] = inst.pos[1] * fit;
    inst.pos[2] = (inst.pos[2] - cz) * fit;
    // the mesh is drawn at inst.scale, so the bounds have to shrink with it
    inst.half = inst.half.map(v => v * fit);
    inst.scale = fit;
  }
  if (fit < 0.999) notes.push(`scaled the assembly to ${Math.round(fit * 100)}% so it sits on the pedestal`);

  return {
    instances: insts,
    joints: findJoints(insts),
    fit,
    bounds: bounds(insts),
    notes
  };
}

/* -------------------------------------------------------------------
   gravity. Anything whose underside is in the air drops until it lands
   on the part below it, or on the pedestal. Side-attached parts (wheels
   on an axle, fins on a body) are exempt — they are held by their
   parent, not by the floor.
   ------------------------------------------------------------------- */
function settle(insts, notes, report) {
  const order = insts.slice().sort((a, b) => (a.pos[1] - a.half[1]) - (b.pos[1] - b.half[1]));
  for (const inst of order) {
    if (inst.fixed) continue;
    const bottom = inst.pos[1] - inst.half[1];
    if (bottom <= 0.015 && bottom >= -0.015) continue;

    /* Anything of OURS that reaches below us is what we are standing on,
       whatever face it went on — a car's wheels hang off the ends of the
       chassis, a crate's walls off its sides. Those parents are not
       floating and must not be dropped: the assembly lift has already put
       the lowest point of the whole build on the pedestal, so moving the
       parent down only buries its own wheels and calls it ride height.

       Note this SKIPS the part rather than resting it on the child's top.
       A child that reaches below us is not necessarily under us — a motor's
       rotor is `inside` its stator and reaches past both ends of it, and
       resting the stator on top of that would stand the motor on itself. */
    let heldFromBelow = false;
    for (const o of insts) {
      if (o === inst || o.parent !== inst.i) continue;
      if (o.pos[1] - o.half[1] < bottom - 0.012) { heldFromBelow = true; break; }
    }
    if (heldFromBelow) continue;

    let support = 0;                                   // the pedestal
    for (const o of insts) {
      if (o === inst) continue;
      const top = o.pos[1] + o.half[1];
      // legs bolted to our underside hold us up by definition, however
      // little of their cross-section happens to sit inside our footprint
      const holdsUs = o.parent === inst.i && o.face === 'bottom';
      if (!holdsUs) {
        if (top > bottom + 0.06) continue;             // above us, can't hold us
        if (footprint(inst, o) < CONTACT_AREA) continue;  // not underneath us
      }
      if (top > support) support = top;
    }
    const drop = bottom - support;
    if (Math.abs(drop) < 0.012) continue;
    if (report && drop > 0.12) {
      notes.push(`"${inst.name}" was floating ${drop.toFixed(2)}m up — dropped it onto ${support > 0.01 ? 'the part below' : 'the pedestal'}`);
    }
    inst.pos[1] = support + inst.half[1];
  }
}

/* -------------------------------------------------------------------
   interpenetration. Parent and child are meant to touch, so they get a
   generous allowance; anything else that is more than a quarter buried
   gets pushed out along whichever axis it is shallowest in.
   ------------------------------------------------------------------- */
function separate(insts) {
  let moved = false;
  for (let i = 0; i < insts.length; i++) {
    for (let j = i + 1; j < insts.length; j++) {
      const a = insts[i], b = insts[j];
      if (a.parent === b.i || b.parent === a.i) continue;
      if (a.group === b.group && a.ofGroup > 1) continue;      // siblings in one array
      /* `inside` is somebody saying, in as many words, that this part
         belongs within another one — a shaft down the middle of a motor, a
         piston in its bore. The parent/child pair above is already spared,
         but the thing it lives inside is often a SIBLING (the shaft hangs
         off the stator and runs through the rotor), and shoving it out
         sideways there put the shaft alongside the motor and toppled the
         whole assembly. Nothing threw; it just stood there wrong. */
      if (a.face === 'inside' || b.face === 'inside') continue;

      const ox = overlapAxis(a, b, 0), oy = overlapAxis(a, b, 1), oz = overlapAxis(a, b, 2);
      if (ox <= 0.001 || oy <= 0.001 || oz <= 0.001) continue;
      const volA = 8 * a.half[0] * a.half[1] * a.half[2];
      const volB = 8 * b.half[0] * b.half[1] * b.half[2];
      const frac = (ox * oy * oz) / Math.max(1e-6, Math.min(volA, volB));
      if (frac < 0.22) continue;

      // whichever is smaller yields, along whichever axis needs the least
      // travel. This has to be the true separating distance, not the size
      // of the overlap: a small part fully swallowed by a big one overlaps
      // by its own width but has to travel much further than that to get out.
      const mover = volA <= volB ? a : b, anchor = mover === a ? b : a;
      if (mover.fixed && !anchor.fixed) continue;

      let bestAx = 1, bestDir = 1, bestCost = Infinity;
      for (let ax = 0; ax < 3; ax++) {
        const up = hi(anchor, ax) - lo(mover, ax);      // shift mover +ve
        const dn = hi(mover, ax) - lo(anchor, ax);      // shift mover -ve
        // downward is never an option on the y axis — under the pedestal is
        // not a place, and settle would only shove it straight back up again
        const dir = ax === 1 ? 1 : (up <= dn ? 1 : -1);
        const cost = (ax === 1 ? up * 0.9 : Math.min(up, dn));
        if (cost < bestCost) { bestCost = cost; bestAx = ax; bestDir = dir; }
      }
      const travel = bestDir > 0
        ? hi(anchor, bestAx) - lo(mover, bestAx)
        : hi(mover, bestAx) - lo(anchor, bestAx);
      mover.pos[bestAx] += bestDir * (travel + 0.01);
      moved = true;
    }
  }
  return moved;
}

function bounds(insts) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const inst of insts) {
    for (let ax = 0; ax < 3; ax++) {
      min[ax] = Math.min(min[ax], inst.pos[ax] - inst.half[ax]);
      max[ax] = Math.max(max[ax], inst.pos[ax] + inst.half[ax]);
    }
  }
  return { min, max };
}

/* -------------------------------------------------------------------
   contact patches. Two parts that actually touch get a seam: metal is
   welded, cardboard is glued, everything else is bolted. This is the
   detail that stops the result reading as loose primitives stacked up.
   ------------------------------------------------------------------- */
const JOINT_KIND = { metal: 'weld', cardboard: 'glue', wood: 'bolt', painted: 'bolt', plastic: 'bolt', glass: 'bolt' };

export function findJoints(insts) {
  const joints = [];
  for (let i = 0; i < insts.length; i++) {
    for (let j = i + 1; j < insts.length; j++) {
      const a = insts[i], b = insts[j];
      const gaps = [0, 1, 2].map(ax => {
        const o = overlapAxis(a, b, ax);
        return o > 0 ? -o : Math.max(lo(a, ax), lo(b, ax)) - Math.min(hi(a, ax), hi(b, ax));
      });
      // touching = separated by < 4cm on exactly one axis, overlapping on the other two
      let touchAxis = -1, ok = true;
      for (let ax = 0; ax < 3; ax++) {
        if (gaps[ax] > 0.04) { ok = false; break; }
        if (gaps[ax] > -0.02) { if (touchAxis >= 0) { ok = false; break; } touchAxis = ax; }
      }
      if (!ok || touchAxis < 0) continue;

      const u = (touchAxis + 1) % 3, v = (touchAxis + 2) % 3;
      const wu = span1(lo(a, u), hi(a, u), lo(b, u), hi(b, u));
      const wv = span1(lo(a, v), hi(a, v), lo(b, v), hi(b, v));
      if (wu < 0.05 || wv < 0.05) continue;

      const pos = [0, 1, 2].map(ax => ax === touchAxis
        ? (a.pos[ax] > b.pos[ax] ? lo(a, ax) : hi(a, ax))
        : (Math.max(lo(a, ax), lo(b, ax)) + Math.min(hi(a, ax), hi(b, ax))) / 2);

      const mat = a.material === b.material ? a.material : (a.material === 'metal' || b.material === 'metal' ? 'metal' : a.material);
      joints.push({
        a: a.i, b: b.i, axis: touchAxis, pos,
        u, v, wu, wv,
        kind: JOINT_KIND[mat] || 'bolt',
        material: mat
      });
    }
  }
  return joints;
}

/* ------------------------------------------------------------------ */
/* readable description, for the critic and for the skill card         */
/* ------------------------------------------------------------------ */
export function describeSolved(solved) {
  return solved.instances.map((p, i) => {
    const [w, h, d] = p.size;
    const r = p.rot.some(v => v) ? `, turned [${p.rot.map(v => Math.round((v * 180) / Math.PI)).join(',')}]deg` : '';
    const n = p.ofGroup > 1 ? ` (${p.indexInGroup + 1} of ${p.ofGroup})` : '';
    return `${i}: "${p.name}"${n} ${p.shape} in ${p.material}, ${w}x${h}x${d}m, centre [${p.pos.map(v => +v.toFixed(2)).join(', ')}]${r}`;
  }).join('\n');
}

/* What is still wrong after solving. The solver fixes physics; it cannot
   fix "you built a lamp with no shade" — that is the model's job. */
export function auditSolved(solved) {
  const issues = [];
  const insts = solved.instances;
  if (!insts.length) return ['nothing was placed on the pedestal'];

  for (const inst of insts) {
    if (inst.fixed) continue;
    const bottom = inst.pos[1] - inst.half[1];
    if (bottom > 0.08) {
      const held = insts.some(o => o !== inst &&
        Math.abs(o.pos[1] + o.half[1] - bottom) < 0.1 &&
        (footprint(inst, o) > CONTACT_AREA || (o.parent === inst.i && o.face === 'bottom')));
      if (!held) issues.push(`"${inst.name}" still has nothing under it`);
    }
  }
  const b = solved.bounds;
  if (b.max[1] < 0.22) issues.push('the build is flat on the pedestal — nothing has any height');
  if ((b.max[0] - b.min[0]) > 0.3 && (b.max[2] - b.min[2]) < 0.08) issues.push('every part lies in one plane — the build has no depth');

  const kinds = new Set(insts.map(p => p.shape));
  if (insts.length >= 3 && kinds.size === 1) {
    issues.push(`every part is a ${[...kinds][0]} — nothing distinguishes one component from another`);
  }
  const distinct = new Set(insts.map(p => p.src)).size;
  if (distinct < 3) issues.push(`only ${distinct} distinct component${distinct === 1 ? '' : 's'} — too few to read as a finished object`);
  return issues;
}
