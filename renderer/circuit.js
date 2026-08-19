/* ------------------------------------------------------------------ *
 * circuit.js — components, the netlist, and whether it would work
 * ------------------------------------------------------------------ *
 *
 * Everything else in this shop is a TREE: a part is bolted to exactly one
 * other part, and that is what lets `assembly.js` resolve a build without
 * ever solving anything simultaneous.
 *
 * A circuit is not a tree. It is a GRAPH — arbitrary pins joined to
 * arbitrary pins, loops everywhere, and the loops are the entire point.
 * So the electrical side gets its own representation that sits alongside
 * the attach tree rather than inside it: a part may have `pins`, and the
 * plan carries a `wires` list saying which pins are joined. The mechanical
 * solver never sees any of it, and the electrical solver never touches a
 * transform.
 *
 * What this file will and will not do:
 *
 *   It WILL work out what is connected to what, apply Ohm's law around a
 *   supply, and tell you the things that actually go wrong on a bench —
 *   an LED wired straight across a battery, a supply shorted to its own
 *   return, a circuit with no way back, a resistor asked to dissipate a
 *   watt and a half, a switch wired across nothing.
 *
 *   It will NOT do nodal analysis, operating points or transient
 *   response. This app renders representative geometry; computing exact
 *   answers about an approximate object is a category error, and the
 *   arithmetic that catches real mistakes is the arithmetic below.
 *
 * Findings come back in exactly the shape `optimize.js` produces, so an
 * electrical fault lands in the same list on the bench as a mechanical
 * one and gets applied through the same edit path.
 */

/* ------------------------------------------------------------------ */
/* the parts bin                                                       */
/* ------------------------------------------------------------------ */
/* Each component knows its pins, what a sensible default value is, and
   what it looks like. `body` is handed to the mechanical side so the
   thing has a real size on the pedestal — a resistor is a small barrel,
   a battery is a slab, a DIP chip is a black box with legs. */
export const COMPONENTS = {
  battery:   { pins: ['+', '-'],        value: 9,    unit: 'V',  label: 'battery',      body: { shape: 'box', size: [0.28, 0.5, 0.18], material: 'plastic' }, source: true },
  cell:      { pins: ['+', '-'],        value: 1.5,  unit: 'V',  label: 'cell',         body: { shape: 'cylinder', size: [0.16, 0.5, 0.16], material: 'metal' }, source: true },
  supply:    { pins: ['+', '-'],        value: 12,   unit: 'V',  label: 'supply',       body: { shape: 'box', size: [0.5, 0.3, 0.4], material: 'metal' }, source: true },

  resistor:  { pins: ['a', 'b'],        value: 220,  unit: 'Ω',  label: 'resistor',     body: { shape: 'cylinder', size: [0.1, 0.26, 0.1], material: 'plastic' }, rating: 0.25 },
  led:       { pins: ['+', '-'],        value: 2,    unit: 'V',  label: 'LED',          body: { shape: 'cylinder', size: [0.14, 0.2, 0.14], material: 'glass' }, imax: 0.02, drop: 2 },
  diode:     { pins: ['+', '-'],        value: 0.7,  unit: 'V',  label: 'diode',        body: { shape: 'cylinder', size: [0.1, 0.22, 0.1], material: 'plastic' }, imax: 1, drop: 0.7 },
  capacitor: { pins: ['+', '-'],        value: 100,  unit: 'µF', label: 'capacitor',    body: { shape: 'cylinder', size: [0.16, 0.3, 0.16], material: 'plastic' } },
  switch:    { pins: ['a', 'b'],        value: 0,    unit: 'Ω',  label: 'switch',       body: { shape: 'box', size: [0.2, 0.16, 0.16], material: 'plastic' } },
  motor:     { pins: ['+', '-'],        value: 40,   unit: 'Ω',  label: 'motor',        body: { shape: 'cylinder', size: [0.3, 0.36, 0.3], material: 'metal' } },
  buzzer:    { pins: ['+', '-'],        value: 60,   unit: 'Ω',  label: 'buzzer',       body: { shape: 'cylinder', size: [0.24, 0.18, 0.24], material: 'plastic' } },
  lamp:      { pins: ['a', 'b'],        value: 30,   unit: 'Ω',  label: 'lamp',         body: { shape: 'sphere', size: [0.2, 0.2, 0.2], material: 'glass' } },
  transistor:{ pins: ['b', 'c', 'e'],   value: 0,    unit: '',   label: 'transistor',   body: { shape: 'cylinder', size: [0.14, 0.16, 0.14], material: 'plastic' } },
  ic:        { pins: ['1', '2', '3', '4', '5', '6', '7', '8'], value: 0, unit: '', label: 'chip', body: { shape: 'box', size: [0.36, 0.08, 0.2], material: 'plastic' } },
  header:    { pins: ['1', '2', '3', '4'], value: 0, unit: '',   label: 'header',       body: { shape: 'box', size: [0.24, 0.1, 0.08], material: 'plastic' } },
  board:     { pins: [],                value: 0,    unit: '',   label: 'board',        body: { shape: 'panel', size: [0.9, 0.05, 0.6], material: 'plastic' }, carrier: true },
  potentiometer: { pins: ['a', 'w', 'b'], value: 10000, unit: 'Ω', label: 'pot',        body: { shape: 'cylinder', size: [0.2, 0.22, 0.2], material: 'plastic' } }
};

export const COMPONENT_IDS = Object.keys(COMPONENTS);
export const isComponent = k => Object.prototype.hasOwnProperty.call(COMPONENTS, String(k || '').toLowerCase());

/* A resistance for anything that behaves like one, so a loop can be
   solved. A diode and an LED are not resistors and are handled as a
   voltage drop instead — treating an LED as a resistor is how you get a
   circuit that "works" on paper and lets the smoke out on the bench. */
function resistanceOf(c) {
  const spec = COMPONENTS[c.component];
  if (!spec) return null;
  if (['resistor', 'motor', 'buzzer', 'lamp', 'potentiometer'].includes(c.component)) return Math.max(0.001, num(c.value, spec.value));
  if (c.component === 'switch') return 0;          // closed; an open switch is simply not wired
  return null;
}
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

/* ------------------------------------------------------------------ */
/* the netlist                                                         */
/* ------------------------------------------------------------------ */
/* A wire says "this pin on this part is joined to that pin on that
   part". Anything transitively joined is one NET — one piece of copper,
   at one voltage. Union-find, because that is exactly the question a net
   answers and it does not care what order the wires were listed in. */
export function netlist(parts, wires) {
  const comps = [];
  (parts || []).forEach((p, i) => {
    if (!p || !isComponent(p.component)) return;
    // a board is a carrier, not a circuit element — it has no pins, so it
    // cannot be part of any net and has no business in a path search
    if (!COMPONENTS[p.component].pins.length) return;
    comps.push({ i, name: p.name || COMPONENTS[p.component].label, component: p.component, value: num(p.value, COMPONENTS[p.component].value) });
  });

  const key = (i, pin) => `${i}.${pin}`;
  const parent = new Map();
  const find = k => {
    if (!parent.has(k)) { parent.set(k, k); return k; }
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(k) !== r) { const n = parent.get(k); parent.set(k, r); k = n; }
    return r;
  };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

  // every pin that exists starts as its own net
  for (const c of comps) for (const pin of COMPONENTS[c.component].pins) find(key(c.i, pin));

  const used = [];
  for (const w of wires || []) {
    const a = pinRef(w?.from, comps), b = pinRef(w?.to, comps);
    if (!a || !b) continue;
    union(a, b);
    used.push({ from: a, to: b });
  }

  const nets = new Map();
  for (const c of comps) {
    for (const pin of COMPONENTS[c.component].pins) {
      const k = key(c.i, pin), root = find(k);
      if (!nets.has(root)) nets.set(root, []);
      nets.get(root).push({ part: c.i, pin, name: c.name });
    }
  }

  return {
    comps,
    wires: used,
    nets: [...nets.values()].map((pins, n) => ({ id: n, pins })),
    // root → the pins sitting on that piece of copper, which is the only
    // lookup the tracer ever needs
    byNet: nets,
    netOf: k => find(k),
    key
  };
}

/* "3.+" or { part: 3, pin: '+' } — models write both, and a pin name that
   does not exist on that component is dropped rather than inventing one. */
function pinRef(ref, comps) {
  if (ref == null) return null;
  let part, pin;
  if (typeof ref === 'string') {
    const m = ref.match(/^\s*(\d+)\s*[.:]\s*(.+?)\s*$/);
    if (!m) return null;
    part = Number(m[1]); pin = m[2];
  } else {
    part = Number(ref.part); pin = String(ref.pin ?? '');
  }
  const c = comps.find(x => x.i === part);
  if (!c) return null;
  const pins = COMPONENTS[c.component].pins;
  const hit = pins.find(p => p.toLowerCase() === String(pin).toLowerCase());
  return hit ? `${part}.${hit}` : null;
}

/* ------------------------------------------------------------------ */
/* solving the loop                                                    */
/* ------------------------------------------------------------------ */
/* One supply, everything else around it. That covers the torch, the
   blinker, the buzzer, the motor on a switch — the circuits this shop
   actually builds. A branching network gets reported honestly as one
   rather than silently averaged into nonsense. */
export function solveCircuit(parts, wires) {
  const nl = netlist(parts, wires);
  const src = nl.comps.find(c => COMPONENTS[c.component].source);
  if (!src) return { ...nl, ok: false, why: 'no power source', supply: 0 };

  const plus = nl.netOf(`${src.i}.+`);
  const minus = nl.netOf(`${src.i}.-`);
  const supply = num(src.value, COMPONENTS[src.component].value);

  if (plus === minus) {
    return { ...nl, ok: false, why: 'the supply is shorted to its own return', supply, shorted: true, source: src };
  }

  /* Walk from + to − through components, collecting what is in the way.
     Depth-first over the netlist: at each net, every component pin on it
     is a way onward. */
  const path = tracePath(nl, plus, minus, src.i);
  if (!path) {
    return { ...nl, ok: false, why: 'nothing joins the supply back to itself — current has no way round', supply, source: src, open: true };
  }

  let R = 0, drop = 0;
  const inPath = [];
  for (const c of path) {
    const r = resistanceOf(c);
    if (r != null) R += r;
    const spec = COMPONENTS[c.component];
    if (spec.drop) drop += spec.drop;
    inPath.push(c);
  }

  // a path of nothing but wire IS a short, even if the supply's own pins
  // are not on the same net
  if (R <= 0.001 && drop <= 0) {
    return { ...nl, ok: false, why: 'the supply is shorted through the wiring', supply, shorted: true, source: src, path: inPath };
  }

  const across = Math.max(0, supply - drop);
  const current = R > 0 ? across / R : Infinity;

  return {
    ...nl, ok: true, supply, source: src, path: inPath,
    resistance: R, drop, current,
    power: inPath.map(c => {
      const r = resistanceOf(c);
      return { ...c, r, watts: r != null ? current * current * r : (COMPONENTS[c.component].drop || 0) * current };
    })
  };
}

/* Depth-first from one net to another, only ever stepping THROUGH a
   component — a net is a piece of copper, so getting onto it is free, and
   the only way off it is out of the other side of something. */
function tracePath(nl, from, to, skipPart) {
  const seen = new Set([from]);
  const walk = (net, acc) => {
    for (const p of nl.byNet.get(net) || []) {
      if (p.part === skipPart) continue;
      const comp = nl.comps.find(c => c.i === p.part);
      if (!comp) continue;
      for (const other of COMPONENTS[comp.component].pins) {
        if (other === p.pin) continue;
        const next = nl.netOf(`${p.part}.${other}`);
        if (next === to) return [...acc, comp];
        if (seen.has(next)) continue;
        seen.add(next);
        const deeper = walk(next, [...acc, comp]);
        if (deeper) return deeper;
      }
    }
    return null;
  };
  return walk(from, []);
}

/* ------------------------------------------------------------------ */
/* what is wrong with it                                               */
/* ------------------------------------------------------------------ */
const F = (id, severity, title, why, gain, patch) =>
  ({ id, kind: 'electrical', severity, title, why, gain, patch });

const fmtR = r => (r >= 1000 ? `${(r / 1000).toFixed(r >= 10000 ? 0 : 1)}kΩ` : `${Math.round(r)}Ω`);
const fmtI = a => (!Number.isFinite(a) ? 'as much as the battery can give'
  : a >= 1 ? `${a.toFixed(2)}A` : a >= 0.001 ? `${Math.round(a * 1000)}mA` : `${Math.round(a * 1e6)}µA`);
const fmtP = w => (w >= 1 ? `${w.toFixed(2)}W` : `${Math.round(w * 1000)}mW`);

export function analyseCircuit(parts, wires) {
  const comps = (parts || []).filter(p => isComponent(p?.component));
  if (!comps.length) return [];
  const out = [];
  const sol = solveCircuit(parts, wires);
  // a part already told it has nothing limiting it does not also need to
  // be told it is over its current rating — same fault, one sentence
  const reported = new Set();

  /* -------- there is no supply ----------------------------------- */
  if (!sol.source) {
    out.push(F('no-supply', 'fault',
      'Nothing powers it',
      `${comps.length} component${comps.length === 1 ? '' : 's'} and not a battery among them`,
      'a cell or a battery, wired to the rest of it',
      null));
    return out;   // everything below needs a supply to mean anything
  }

  /* -------- a dead short ----------------------------------------- */
  if (sol.shorted) {
    out.push(F('short', 'fault',
      'The supply is shorted',
      sol.why + ' — every amp it can give goes straight round with nothing to limit it',
      'put the load, and a resistor, in the way before the two sides meet',
      null));
  }

  /* -------- no way round ----------------------------------------- */
  if (sol.open) {
    const loose = looseEnds(sol);
    out.push(F('open', 'fault',
      'The circuit does not close',
      loose.length
        ? `nothing is wired to ${loose.slice(0, 3).map(x => `${x.name} ${x.pin}`).join(', ')}`
        : 'there is no path from the supply back to itself',
      'current only flows in a loop — wire the last pin back to the return',
      null));
  }

  /* -------- an LED with nothing limiting it ----------------------- */
  /* The single most common mistake anyone makes with electronics, and
     the one that costs an LED every time. */
  for (const c of sol.comps) {
    if (c.component !== 'led') continue;
    const series = sol.ok ? sol.path : [];
    const hasR = series.some(x => x.component === 'resistor' || x.component === 'potentiometer');
    const onPath = series.some(x => x.i === c.i);
    if (!onPath || hasR) continue;
    const want = Math.round(Math.max(0, sol.supply - 2) / 0.015);
    reported.add(c.i);
    out.push(F(`led-${c.i}`, 'fault',
      `The ${c.name} has nothing limiting its current`,
      `straight across ${sol.supply}V, an LED draws whatever the battery will give and lasts about a second`,
      `a ${fmtR(nearestE12(want))} resistor in series holds it near 15mA`,
      { kind: 'add-series', part: c.i, component: 'resistor', value: nearestE12(want) }));
  }

  if (!sol.ok) return sortFindings(out);

  /* -------- a part being asked to dissipate too much -------------- */
  for (const p of sol.power || []) {
    const rating = COMPONENTS[p.component].rating;
    if (!rating || p.watts <= rating) continue;
    const bigger = nearestE12(Math.max(0, sol.supply - sol.drop) ** 2 / (rating * 0.5));
    out.push(F(`watts-${p.i}`, 'fault',
      `The ${p.name} runs too hot`,
      `${fmtP(p.watts)} through a ${fmtP(rating)} part — it discolours, drifts and eventually opens`,
      `either a ${fmtR(bigger)} resistor, or the same value in a bigger package`,
      { kind: 'edit-value', part: p.i, value: bigger }));
  }

  /* -------- more current through a part than it will take --------- */
  for (const c of sol.path || []) {
    const imax = COMPONENTS[c.component].imax;
    if (!imax || sol.current <= imax || reported.has(c.i)) continue;
    const want = nearestE12(Math.max(0, sol.supply - sol.drop) / (imax * 0.75));
    out.push(F(`imax-${c.i}`, 'fault',
      `${fmtI(sol.current)} through the ${c.name}`,
      `it is rated to ${fmtI(imax)}${Number.isFinite(sol.current) ? ` — this is ${Math.round(sol.current / imax)}× over` : ' and there is nothing in the way'}`,
      `${fmtR(want)} in series brings it inside its rating`,
      { kind: 'add-series', part: c.i, component: 'resistor', value: want }));
  }

  /* -------- a component wired to nothing -------------------------- */
  const loose = looseEnds(sol);
  for (const l of loose.slice(0, 3)) {
    out.push(F(`float-${l.part}-${l.pin}`, 'improvement',
      `The ${l.name}'s ${l.pin} pin goes nowhere`,
      'it is on the board, it gets soldered, and it does nothing',
      'wire it in or leave it out',
      null));
  }

  /* -------- how long it runs -------------------------------------- */
  /* Not a fault — the number people actually want, and the one that
     changes a design. A 9V block is about 550mAh. */
  if (sol.current > 0 && Number.isFinite(sol.current)) {
    const mAh = { battery: 550, cell: 2000, supply: 0 }[sol.source.component] ?? 0;
    if (mAh) {
      const hours = mAh / 1000 / sol.current;
      out.push(F('runtime', 'note',
        `It draws ${fmtI(sol.current)}`,
        `${fmtR(sol.resistance)} in the loop across ${sol.supply}V${sol.drop ? `, less ${sol.drop}V of junction drop` : ''}`,
        hours < 2 ? `a ${sol.source.name} lasts about ${Math.round(hours * 60)} minutes`
          : `a ${sol.source.name} lasts about ${hours < 48 ? `${Math.round(hours)} hours` : `${Math.round(hours / 24)} days`}`,
        null));
    }
  }

  return sortFindings(out);
}

function sortFindings(list) {
  const rank = { fault: 0, improvement: 1, note: 2 };
  return list.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/* A pin on a net with nothing else on it is not wired to anything. */
function looseEnds(sol) {
  const out = [];
  for (const net of sol.nets || []) {
    if (net.pins.length > 1) continue;
    const p = net.pins[0];
    if (!p) continue;
    out.push(p);
  }
  return out;
}

/* Resistors come in preferred values, and this always rounds UP to the
   next one. That is not fussiness: every value this function is asked for
   is a current limit, and a limiter rounded DOWN passes more current than
   was asked for — which is the exact failure it was put in to prevent.
   Ask for 427Ω and the drawer hands you 470Ω. */
const E12 = [10, 12, 15, 18, 22, 27, 33, 39, 47, 56, 68, 82];
export function nearestE12(v) {
  if (!Number.isFinite(v) || v <= 0) return 220;
  const decade = Math.floor(Math.log10(v));
  const scaled = v / 10 ** (decade - 1);
  const up = E12.find(e => e >= scaled - 1e-9);
  return Math.round((up ?? 100) * 10 ** (decade - 1));
}

/* ------------------------------------------------------------------ */
/* saying it in words                                                  */
/* ------------------------------------------------------------------ */
/* For the critique prompt: the model cannot read a netlist, but it can
   read "9V battery → switch → 220Ω resistor → LED → back to the battery"
   and tell you it is a torch. */
export function describeCircuit(parts, wires) {
  const sol = solveCircuit(parts, wires);
  if (!sol.comps.length) return '';
  const bits = [`${sol.comps.length} components: ${sol.comps.map(c => `${c.i}:${c.name}`).join(', ')}`];
  if (!sol.source) bits.push('no power source');
  else if (sol.ok) {
    bits.push(`${sol.supply}V ${sol.source.name} → ${sol.path.map(c => c.name).join(' → ')} → back to the ${sol.source.name}`);
    bits.push(`${fmtR(sol.resistance)} in the loop, ${fmtI(sol.current)} flowing`);
  } else bits.push(sol.why);
  return bits.join('\n');
}

/* What goes in the planning prompt. Written as instructions rather than a
   schema dump because the schema is already handed over separately and
   the model needs to know the CONVENTIONS — that a wire is a pin pair,
   that an LED always gets a resistor, that a loop has to close. */
export function electricalBlock(request) {
  if (!/\b(circuit|electr|electronic|led|light|lamp|torch|flashlight|battery|power|switch|motor|buzzer|sensor|arduino|wire|solder|board|pcb|blink|alarm|amplifier|radio|charger|relay|resist|capacit)\w*\b/i.test(request || '')) return '';

  return `
WIRING IT UP
This one has electronics in it. A part can be a COMPONENT instead of a
plain shape — set "component" to one of:
  ${COMPONENT_IDS.join(', ')}
and give it a "value" (a battery in volts, a resistor in ohms). The shop
knows what each one looks like, so a component does not need a shape.

Components are joined by WIRES, listed once at the top level of the plan:
  "wires": [ { "from": "0.+", "to": "1.a" }, { "from": "1.b", "to": "2.+" } ]
"0.+" means the + pin of part 0. Pin names by component:
  battery, cell, supply, led, diode, capacitor, motor, buzzer   + and -
  resistor, switch, lamp                                         a and b
  potentiometer                                                  a, w, b
  transistor                                                     b, c, e
  ic                                                             1 to 8

THE RULES THAT MATTER
  · Current only flows in a LOOP. Every circuit goes out of the supply's
    + pin, through everything, and back into its - pin. If the last part
    is not wired back to the battery, nothing happens.
  · An LED ALWAYS has a resistor in series with it. Always. Straight
    across a battery it draws everything the battery has and dies.
    9V and an LED wants about 470Ω; 3V wants about 100Ω.
  · Never wire + straight to -. That is a short, and it is the one
    mistake that ruins the battery rather than the component.
  · A switch goes IN the loop, in series, not across it.

Mount the components on a board and the board on whatever the object is —
that part is ordinary attachment, exactly like any other part.

Worked example — a torch
  part 0  board     component "board"
  part 1  battery   component "battery"  value 9   attach { to:0, face:"top" }
  part 2  switch    component "switch"             attach { to:0, face:"top", dx:0.25 }
  part 3  resistor  component "resistor" value 470 attach { to:0, face:"top", dx:-0.25 }
  part 4  led       component "led"                attach { to:0, face:"top", dz:0.2 }
  wires: 1.+ → 2.a, 2.b → 3.a, 3.b → 4.+, 4.- → 1.-`;
}

/* ------------------------------------------------------------------ */
/* keeping the model honest                                           */
/* ------------------------------------------------------------------ */
/* The same job validatePlan does for geometry. A wire to a pin that does
   not exist, to a part that is not a component, or from a pin to itself
   is dropped rather than carried into the netlist. */
export function validateWires(wires, parts) {
  const comps = (parts || []).map((p, i) => ({ i, component: String(p?.component || '').toLowerCase() }))
    .filter(c => isComponent(c.component));
  if (!comps.length) return [];

  const seen = new Set();
  const out = [];
  for (const w of Array.isArray(wires) ? wires.slice(0, 40) : []) {
    const from = pinRef(w?.from, comps.map(c => ({ ...c, name: '' })));
    const to = pinRef(w?.to, comps.map(c => ({ ...c, name: '' })));
    if (!from || !to || from === to) continue;
    const k = [from, to].sort().join('|');
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ from, to });
  }
  return out;
}

/* A component's body, for the mechanical side. Anything the model said
   about shape or size is ignored — a resistor is a resistor. */
export function bodyFor(component, spec = {}) {
  const c = COMPONENTS[String(component || '').toLowerCase()];
  if (!c) return null;
  /* The catalogue wins outright. A part that reached here without a
     material stated would otherwise take validatePlan's default, and the
     shop would solemnly report a cardboard resistor. */
  return { shape: c.body.shape, material: c.body.material, size: c.body.size.slice() };
}

/* Where a wire physically lands on a component, as a fraction of its own
   half-extent. Pins are at the ends of the body for a two-pin part and
   spread along it for anything with more. */
export function pinOffset(component, pin) {
  const c = COMPONENTS[String(component || '').toLowerCase()];
  if (!c) return [0, 0, 0];
  const pins = c.pins;
  const at = Math.max(0, pins.indexOf(pin));
  if (pins.length <= 2) return [0, at === 0 ? 0.9 : -0.9, 0];
  const t = pins.length === 1 ? 0 : (at / (pins.length - 1)) * 2 - 1;
  return [t * 0.85, -0.6, 0];
}
