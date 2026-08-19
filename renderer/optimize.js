/* ------------------------------------------------------------------ *
 * optimize.js — what an engineer notices that an inspector does not
 * ------------------------------------------------------------------ *
 *
 * The critic in critic.js asks one question: does this read as the thing
 * that was asked for. That is a designer's question and it is worth
 * asking, but it is not the only one. An engineer looking at the same
 * build asks a different set:
 *
 *   will it stand up
 *   is that part carrying a load the material cannot take
 *   is there material in there doing no work
 *   are those four identical parts really four operations
 *   is that part visible at all
 *   and did we walk the length of the shop six times to make it
 *
 * Every one of those is arithmetic, so none of it belongs in a prompt.
 * This file answers them from the solved assembly and returns findings
 * that carry a real number for the gain and a patch that the bench can
 * apply through the normal edit path — which means undo reverses an
 * optimisation exactly like it reverses a keystroke.
 *
 * The hard rule here is NO FALSE POSITIVES. An optimiser that cries wolf
 * on a build that is fine gets switched off within a day, and then the
 * one time it was right about a topple you are not listening. Every
 * threshold below is set where a build genuinely has the fault, not
 * where it might, and every rule has a test that fires it on a bad build
 * and a matching one that keeps it quiet on a good one.
 */

import { effectiveSize, halfExtents, MATERIALS } from './assembly.js';
import { walkBetween } from './roles.js';
import { assemblyMetrics, partMetrics, densityOf, formatLen, formatMass } from './metrics.js';
import { planParts, editPart, removePart, addPart } from './agent.js';
import { analyseCircuit, isComponent, nearestE12, COMPONENTS } from './circuit.js';
import { analyseEngine, applyEnginePatch, sizeEngine, engineParts } from './engine.js';

/* A part of an engine is exempt from the structural rules for the same
   reason a component is: its size came off the bore or the annulus area,
   not off a judgement about what would look right, and telling somebody
   their crankshaft is slender is telling them their engine is an engine. */
const symbolic = p => isComponent(p.component) || !!p.engine_role;

/* The shop is a straight line of rooms, PITCH apart, and these are the
   real x positions out of world.js — not a guess. Walking is the single
   biggest cost in a plan's runtime and the only one the planner has any
   control over, so getting the distances wrong here quietly mis-prices
   every plan. Electronics is at the far end, which is exactly why a plan
   that keeps going back for one more component is worth flagging. */
/* These used to be typed in again here, because optimize.js has to stay
   headless and world.js pulls in three.js. They then went stale the moment
   the walls came down: the optimiser was pricing walks against a five-room
   shop with a 22-metre pitch that no longer existed. roles.js is headless
   and owns the floor plan, so it owns this too. */
export const walkCost = walkBetween;

/* What a material will take. Cardboard is not structural, glass is not
   structural, and the difference between "it held" and "it folded" is
   roughly an order of magnitude in the load a section will carry. These
   are working numbers for a shop, not a code check — the point is to
   separate 200g on a card tab from 40kg on a card tab. */
/* kg a part of this material will hold up. Generous, on purpose: these
   are solid primitives at half a metre across, so the masses involved are
   large and the rule is meant to catch a material that is plainly wrong —
   a card tab under an anvil — not to second-guess every steel section. */
const LOAD_LIMIT = {
  cardboard: 8,
  glass: 40,
  plastic: 150,
  painted: 260,
  wood: 600,
  metal: 5000
};
const STRONGER = ['cardboard', 'glass', 'plastic', 'painted', 'wood', 'metal'];

/* A plate a fifth as thick as it is wide is a plate. Past that it is a
   billet doing a plate's job. The upper bound matters as much as the
   lower one: a cube is not a fat plate, it is a cube, and a rule that
   cannot tell the difference is a rule that fires on every block in the
   shop. */
const THICK_RATIO = 0.22;
const NOT_A_BLOCK = 0.75;
/* Slenderness past this and the part is a whisker. Only ever applied to
   boxes — a rod IS thin, that is what a rod is for, and flagging every
   rod in the shop is the fastest way to make the panel useless. */
const SLENDER = 12;

const clone = p => JSON.parse(JSON.stringify(p));
const round = (v, n = 3) => Math.round(v * 10 ** n) / 10 ** n;

/* ------------------------------------------------------------------ */
/* the load path                                                       */
/* ------------------------------------------------------------------ */
/* How much mass each part is holding up: its own, plus everything
   attached above it, all the way down the tree. This is the number that
   decides whether a material choice is wrong, and it is not something
   you can see by looking at one part. */
export function loadPath(parts, solved) {
  const massOf = new Map();
  for (const inst of solved?.instances || []) {
    // a component's rendered body is a symbol, not a billet — counting a
    // motor as a quarter tonne of steel poisons every load below it
    if (isComponent(parts[inst.src]?.component)) continue;
    massOf.set(inst.src, (massOf.get(inst.src) || 0) + partMetrics(inst).mass);
  }

  const carried = parts.map((_, i) => massOf.get(i) || 0);
  // walk from the leaves down: a part's parent carries whatever it carries
  for (let i = parts.length - 1; i >= 0; i--) {
    const to = parts[i]?.attach?.to;
    // only a part standing ON another is loading it — something bolted to
    // a side face is hanging, which is a different problem and not this one
    if (to == null || to >= i) continue;
    if (parts[i].attach.face !== 'top') continue;
    carried[to] += carried[i];
  }
  return carried;
}

/* ------------------------------------------------------------------ */
/* the findings                                                        */
/* ------------------------------------------------------------------ */
/* A finding is a sentence a person can act on and a patch the bench can
   apply. `gain` is the reason to bother — in kilograms, in metres, in
   operations saved. Anything without a gain is a note, not a finding. */
function F(id, kind, severity, title, why, gain, patch) {
  return { id, kind, severity, title, why, gain, patch };
}

export function analyse(plan, solved) {
  if (!plan || !solved?.instances?.length) return [];
  const parts = planParts(plan);
  if (!parts.length) return [];

  const m = assemblyMetrics(solved);
  const carried = loadPath(parts, solved);
  const found = [];

  /* -------- it falls over ---------------------------------------- */
  /* The one finding that is a fault rather than an improvement. The
     solver is perfectly happy with a build whose mass sits outside its
     own footprint; it only becomes a problem when the thing is real. */
  if (!m.stable && m.tipRatio > 1) {
    const ground = groundPart(parts, solved);
    if (ground) {
      // widen the base until the centre of mass is comfortably inside it,
      // with a margin so a later edit does not put it straight back out
      const need = m.tipRatio * 1.35;
      const size = parts[ground.src].size.slice();
      const grow = Math.min(2.5, round(Math.max(size[0], size[2]) * need));
      size[0] = grow; size[2] = grow;
      found.push(F('topple', 'product', 'fault',
        'It falls over',
        `the centre of mass sits ${Math.round((m.tipRatio - 1) * 100)}% outside the footprint — there is nothing under it on that side`,
        `widening the ${parts[ground.src].name} to ${formatLen(grow, 'mm')} puts the mass back over the base`,
        { kind: 'edit', part: ground.src, set: { sx: size[0], sz: size[2] } }));
    }
  } else if (m.tipRatio > 0.78) {
    found.push(F('marginal', 'product', 'note',
      'It stands, but only just',
      `the centre of mass is ${Math.round(m.tipRatio * 100)}% of the way to the edge of the footprint`,
      'a nudge or a knock puts it over — widen the base if it is meant to be handled',
      null));
  }

  /* -------- the material cannot take the load --------------------- */
  /* Components are exempt from every structural rule below. A resistor on
     screen is a 260mm barrel because it has to be visible from across the
     shop; weighed as solid stock that is two kilos, and the load rules
     would spend all day telling you a circuit board cannot hold its own
     resistors. The body is a symbol. The electrical checks are the ones
     that mean something about a component, and they are in circuit.js. */
  parts.forEach((p, i) => {
    if (symbolic(p)) return;
    const limit = LOAD_LIMIT[p.material] ?? LOAD_LIMIT.plastic;
    const load = carried[i] - (partMetrics(solved.instances.find(x => x.src === i) || {}).mass || 0);
    if (load <= limit) return;
    const stronger = STRONGER.slice(STRONGER.indexOf(p.material) + 1);
    if (!stronger.length) return;
    // the lightest material that takes the load with margin, and if nothing
    // does, the strongest there is — a load past steel is still better in
    // steel than in cardboard
    const better = stronger.find(mat => (LOAD_LIMIT[mat] ?? 0) >= load * 1.4) || stronger.at(-1);
    found.push(F(`load-${i}`, 'product', 'fault',
      `The ${p.name} is carrying more than ${p.material} will hold`,
      `${formatMass(load)} of structure sits on it, and ${p.material} gives up somewhere around ${formatMass(limit)}`,
      `in ${better} it carries the load with room to spare`,
      { kind: 'edit', part: i, set: { material: better } }));
  });

  /* -------- material doing no work -------------------------------- */
  /* A panel drawn as thick as it is wide is not a panel, and the mass is
     real: this is the finding that saves you a kilo of stock. */
  parts.forEach((p, i) => {
    // a panel is thinned by the solver already; a box is not
    if (p.shape !== 'box' || symbolic(p)) return;
    const s = effectiveSize(p.shape, p.size);
    const [thin, mid, big] = [...s].sort((a, b) => a - b);
    if (big < 0.5) return;                                   // too small to be worth stock
    if (big / mid > 2.5) return;                             // a stick, not a plate
    const r = thin / big;
    if (r <= THICK_RATIO || r >= NOT_A_BLOCK) return;         // already thin, or simply a block
    const axis = s.indexOf(thin);
    // what it carries, not counting itself — a heavy part is not busy just
    // because it is heavy, which is the whole point of the finding
    const own = partMetrics(solved.instances.find(x => x.src === i) || {}).mass || 0;
    if (carried[i] - own > LOAD_LIMIT[p.material] * 0.35) return;

    const target = round(big * THICK_RATIO * 0.9);
    const before = partMetrics({ shape: p.shape, size: p.size, material: p.material }).mass;
    const nextSize = p.size.slice(); nextSize[axis] = target;
    const after = partMetrics({ shape: p.shape, size: nextSize, material: p.material }).mass;
    if (before - after < 0.05) return;

    found.push(F(`thick-${i}`, 'product', 'improvement',
      `The ${p.name} is a slab where a plate would do`,
      `${formatLen(thin, 'mm')} of stock across a ${formatLen(big, 'mm')} face, carrying almost nothing`,
      `taking it to ${formatLen(target, 'mm')} saves ${formatMass(before - after)}`,
      { kind: 'edit', part: i, set: { [['sx', 'sy', 'sz'][axis]]: target } }));
  });

  /* -------- four parts that are one part -------------------------- */
  /* Models emit "leg, leg, leg, leg" as four steps far more often than
     they should. Each one is a separate trip to the bench. */
  const groups = new Map();
  parts.forEach((p, i) => {
    if (p.array?.mode && p.array.mode !== 'none') return;
    const key = `${p.attach?.to ?? 'ground'}|${p.attach?.face ?? '-'}|${p.shape}|${p.material}|${p.size.map(v => round(v, 2)).join(',')}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  });
  for (const [, idx] of groups) {
    if (idx.length < 3) continue;
    const p = parts[idx[0]];
    const mode = idx.length === 4 ? 'quad' : 'ring';
    found.push(F(`array-${idx[0]}`, 'process', 'improvement',
      `${idx.length} of the ${p.name} are ${idx.length} separate operations`,
      'they are identical, on the same face of the same part, and the shop can make a set in one go',
      `one ${mode} array instead — ${idx.length - 1} fewer trips to the bench`,
      { kind: 'array', part: idx[0], mode, count: idx.length, drop: idx.slice(1) }));
  }

  /* -------- a part nobody can see --------------------------------- */
  parts.forEach((p, i) => {
    /* An engine is full of things you cannot see and must not scrap — a
       piston lives inside its bore, a stator inside the rotor can, a shaft
       inside the nacelle. "Nothing of it shows" is the definition of those
       parts working, not of them being waste. Same exemption components
       already have, and the same reason: the body is a symbol. */
    if (symbolic(p)) return;
    const inst = solved.instances.find(x => x.src === i);
    if (!inst) return;
    const host = solved.instances.find(x => x.src !== i && contains(x, inst));
    if (!host) return;
    found.push(F(`buried-${i}`, 'product', 'improvement',
      `The ${p.name} is completely inside the ${parts[host.src]?.name || 'part next to it'}`,
      'nothing of it shows, and it is still cut, worked and carried across the shop',
      `scrapping it saves an operation and ${formatMass(partMetrics(inst).mass)}`,
      { kind: 'remove', part: i }));
  });

  /* -------- a whisker --------------------------------------------- */
  parts.forEach((p, i) => {
    if (!['box', 'wedge'].includes(p.shape) || symbolic(p)) return;
    const s = effectiveSize(p.shape, p.size);
    const ratio = Math.max(...s) / Math.max(1e-6, Math.min(...s));
    if (ratio < SLENDER) return;
    const thin = Math.min(...s), axis = s.indexOf(thin);
    const target = round(Math.max(...s) / (SLENDER * 0.6));
    found.push(F(`slender-${i}`, 'product', 'improvement',
      `The ${p.name} is ${Math.round(ratio)} times longer than it is thick`,
      'that is a wire, not a member — it will bow under its own weight before it carries anything',
      `taking it to ${formatLen(target, 'mm')} across makes it a part`,
      { kind: 'edit', part: i, set: { [['sx', 'sy', 'sz'][axis]]: target } }));
  });

  /* -------- the walking ------------------------------------------- */
  found.push(...processFindings(plan));

  /* -------- and whether it would actually work -------------------- */
  /* An electrical fault is a fault in exactly the same sense as a build
     that falls over, so it goes in the same list and gets applied the
     same way. A build with no components in it produces nothing here. */
  found.push(...analyseCircuit(parts, plan.wires));

  /* And whether it would run. Same list, same shape, same apply path — a
     compression ratio that detonates is a fault in exactly the sense that
     a build which falls over is. A plan with no engine on it produces
     nothing here. */
  found.push(...analyseEngine(plan));

  // faults first, then the biggest wins, and never more than fits on screen
  const rank = { fault: 0, improvement: 1, note: 2 };
  return found.sort((a, b) => rank[a.severity] - rank[b.severity]).slice(0, 12);
}

/* ------------------------------------------------------------------ */
/* the process, as opposed to the product                              */
/* ------------------------------------------------------------------ */
function processFindings(plan) {
  const out = [];
  const steps = plan.steps || [];

  /* Room thrash. Steps that make parts have to keep their order — part 3
     may be attached to part 1 — but consecutive steps in the SAME room
     can be gathered without changing what gets made in what order, and
     the walking that saves is real metres. */
  const order = tidyOrder(steps);
  const before = walkOf(steps.map(s => s.room));
  const after = walkOf(order.map(i => steps[i].room));
  if (before - after > 12) {
    out.push(F('thrash', 'process', 'improvement',
      'The plan crosses the shop more than it needs to',
      `${Math.round(before)}m of walking to make ${steps.length} operations, doubling back between stations`,
      `gathering the work by room cuts it to ${Math.round(after)}m — ${Math.round(before - after)}m less on his feet`,
      { kind: 'reorder', order }));
  }

  /* The wrong tool for the material. Welding cardboard is the funny one;
     gluing steel is the one that actually happens. */
  const WRONG = [
    { act: /^(weld|braze|solder|forge|quench|anvil|hammer_anvil|grind)/, bad: ['cardboard', 'plastic', 'glass'], use: 'glue', why: 'that is a heat process' },
    { act: /^(glue|tape)/, bad: ['metal'], use: 'weld', why: 'glue will not hold a steel joint' }
  ];
  steps.forEach((s, i) => {
    const mat = s.part?.material;
    if (!mat) return;
    // soldering a component to a plastic board is the entire job, not a
    // mistake — the heat rule is about melting the workpiece
    if (isComponent(s.part?.component)) return;
    for (const w of WRONG) {
      if (!w.act.test(s.action) || !w.bad.includes(mat)) continue;
      out.push(F(`tool-${i}`, 'process', 'fault',
        `Step ${i + 1} ${s.action.replace(/_/g, ' ')}s ${mat}`,
        `${w.why} — ${mat} does not survive it`,
        `${w.use} is the operation that joins ${mat}`,
        null));
      break;
    }
  });

  /* Nothing was measured or checked before it was assembled. */
  const checks = steps.filter(s => /measure|inspect|caliper|test_fit|mark/.test(s.action)).length;
  if (steps.length >= 8 && checks === 0) {
    out.push(F('unchecked', 'process', 'note',
      'Nothing gets measured before it goes together',
      `${steps.length} operations and not one check`,
      'a measure step before assembly is the cheapest operation in the shop',
      null));
  }

  return out;
}

/* Gather consecutive work by room without disturbing the order parts are
   created in — a part can only ever attach to an earlier one, so moving a
   part-making step ahead of another part-making step is not safe. Only
   steps with no part are free to move. */
export function tidyOrder(steps) {
  const idx = steps.map((_, i) => i);
  const out = [];
  const free = [];
  for (const i of idx) {
    if (steps[i].part || steps[i].room === 'finished') { out.push(i); }
    else free.push(i);
  }
  // drop each free step next to the nearest step already in its own room
  for (const f of free) {
    const room = steps[f].room;
    let at = out.findIndex(i => steps[i].room === room);
    at = at < 0 ? out.length : at + 1;
    out.splice(at, 0, f);
  }
  return out;
}

function walkOf(rooms) {
  let total = 0;
  for (let i = 1; i < rooms.length; i++) total += walkCost(rooms[i - 1], rooms[i]);
  return total;
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */
/* The part actually standing on the pedestal — the one to widen when the
   thing topples. Lowest, and if two are level, the broadest. */
function groundPart(parts, solved) {
  const floor = Math.min(...solved.instances.map(i => i.pos[1] - i.half[1]));
  return solved.instances
    .filter(i => i.pos[1] - i.half[1] < floor + 0.03 && parts[i.src])
    .sort((a, b) => (b.half[0] * b.half[2]) - (a.half[0] * a.half[2]))[0] || null;
}

/* b sits entirely within a, with a little slack so a part that is flush
   on one face is not called buried. */
function contains(a, b) {
  for (let k = 0; k < 3; k++) {
    if (b.pos[k] - b.half[k] < a.pos[k] - a.half[k] - 0.005) return false;
    if (b.pos[k] + b.half[k] > a.pos[k] + a.half[k] + 0.005) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* applying one                                                        */
/* ------------------------------------------------------------------ */
/* Everything goes through the same editPart / removePart the properties
   panel uses, so an optimisation is clamped by exactly the same rules as
   something typed by hand, and lands on the undo stack the same way.
   Nothing here is a special case that bypasses the contract. */
export function applyFinding(plan, finding) {
  if (!finding?.patch) return plan;
  const p = finding.patch;

  if (p.kind === 'edit') {
    let next = plan;
    for (const [field, value] of Object.entries(p.set)) next = editPart(next, p.part, { [field]: value });
    return next;
  }

  if (p.kind === 'remove') return removePart(plan, p.part);

  if (p.kind === 'array') {
    // turn the survivor into the array, then scrap the duplicates from the
    // BACK so the earlier indices stay valid while we work
    let next = editPart(plan, p.part, { mode: p.mode, count: p.count });
    for (const i of [...p.drop].sort((a, b) => b - a)) next = removePart(next, i);
    return next;
  }

  /* Drop a resistor into the loop in front of a component. The new part
     is appended, wired in place of the connection it interrupts, and the
     old wire is removed — which is exactly what you would do at the
     bench, and it goes through addPart so the indices stay honest. */
  if (p.kind === 'add-series') {
    const parts = planParts(plan);
    const victim = parts[p.part];
    if (!victim) return plan;
    const added = addPart(clone(plan), {
      name: `${nearestE12(p.value)}Ω`, component: 'resistor', value: nearestE12(p.value)
    });
    const next = added.plan;
    const at = added.index;
    // sit it next to the part it protects rather than on the end of the stack
    const step = next.steps.find(s => s.part && s.part.value === nearestE12(p.value) && s.part.component === 'resistor');
    if (step && victim.attach) step.part.attach = { ...victim.attach, dx: (victim.attach.dx || 0) + 0.22 };
    const feed = COMPONENTS[victim.component].pins[0];
    const wires = (next.wires || []).slice();
    const inbound = wires.findIndex(w => w.to === `${p.part}.${feed}` || w.from === `${p.part}.${feed}`);
    if (inbound >= 0) {
      const w = wires[inbound];
      const other = w.to === `${p.part}.${feed}` ? w.from : w.to;
      wires.splice(inbound, 1, { from: other, to: `${at}.a` }, { from: `${at}.b`, to: `${p.part}.${feed}` });
    } else {
      wires.push({ from: `${at}.b`, to: `${p.part}.${feed}` });
    }
    return { ...next, wires };
  }

  if (p.kind === 'edit-value') {
    const next = clone(plan);
    let n = 0;
    for (const st of next.steps) {
      if (!st.part) continue;
      if (n === p.part) { st.part.value = nearestE12(p.value); break; }
      n++;
    }
    return next;
  }

  /* An engine patch changes the SPEC, not a part — and then every part
     that came off that spec is re-sized from it. Going through the same
     validate-and-rebody path as a keystroke on the bench, so an optimiser
     cannot put a number into the engine that a person could not. */
  if (p.kind === 'edit-spec') {
    const next = clone(plan);
    const engine = applyEnginePatch(next.engine, p.set);
    if (!engine) return plan;
    next.engine = engine;
    const bodies = engineParts(sizeEngine(engine));
    const used = new Set();
    for (const st of next.steps) {
      const role = st.part?.engine_role;
      if (!role) continue;
      const j = bodies.findIndex((b, i) => b.engine_role === role && !used.has(i));
      if (j < 0) continue;
      used.add(j);
      st.part.shape = bodies[j].shape;
      st.part.size = bodies[j].size.slice();
      st.part.material = bodies[j].material;
      if (bodies[j].array) st.part.array = { ...bodies[j].array };
    }
    return next;
  }

  if (p.kind === 'reorder') {
    const next = clone(plan);
    next.steps = p.order.map(i => plan.steps[i]).filter(Boolean);
    return next;
  }

  return plan;
}

export function applyAll(plan, findings) {
  /* One at a time, re-analysing is the caller's job. Removals and arrays
     renumber everything after them, so applying two of those from the
     same analysis would use stale indices — the caller applies one, then
     asks for a fresh analysis. Edits are index-stable and safe in a batch. */
  let next = plan;
  const safe = findings.filter(f => f.patch?.kind === 'edit');
  for (const f of safe) next = applyFinding(next, f);
  return next;
}

/* A one-line summary for the log — what he found, without the detail. */
export function summariseFindings(findings) {
  if (!findings.length) return 'nothing worth changing';
  const faults = findings.filter(f => f.severity === 'fault').length;
  const wins = findings.filter(f => f.severity === 'improvement').length;
  const bits = [];
  if (faults) bits.push(`${faults} fault${faults === 1 ? '' : 's'}`);
  if (wins) bits.push(`${wins} improvement${wins === 1 ? '' : 's'}`);
  if (!bits.length) bits.push(`${findings.length} note${findings.length === 1 ? '' : 's'}`);
  return bits.join(' and ');
}
