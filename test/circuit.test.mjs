/* The electrical side.

   Same bar as the optimiser: every rule is fired on a circuit that has the
   fault and kept quiet on one that does not. An electrical warning that
   cries wolf is worse than useless, because the whole reason to have one
   is that "it looks fine" is exactly what a shorted battery looks like.

   The arithmetic is checked against numbers worked by hand — 9V through a
   470Ω resistor with an LED's 2V drop is 14.9mA, and if that ever comes
   out as something else the check below says so rather than the app
   quietly reporting a plausible wrong answer.

     node test/circuit.test.mjs
*/
import {
  COMPONENTS, COMPONENT_IDS, isComponent, netlist, solveCircuit, analyseCircuit,
  describeCircuit, electricalBlock, validateWires, nearestE12, bodyFor, pinOffset
} from '../renderer/circuit.js';
import { validatePlan, planParts, offlinePlan, PLAN_SCHEMA } from '../renderer/agent.js';
import { inspectPlan } from '../renderer/critic.js';
import { analyse, applyFinding } from '../renderer/optimize.js';
import { classifyRequest } from '../renderer/library.js';

let pass = 0, fail = 0;
const out = [];
const check = (name, fn) => {
  try { fn(); pass++; out.push(`  ok    ${name}`); }
  catch (e) { fail++; out.push(`  FAIL  ${name}\n          ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const near = (a, b, tol, m) => assert(Math.abs(a - b) <= tol, `${m} (${a} vs ${b})`);

/* A component part as the planner would emit it. Deliberately gives a
   silly shape and size every time, because validatePlan is supposed to
   throw those away and use the catalogue. */
const P = (name, component, value, attach) => ({
  name, component, value, shape: 'box', material: 'cardboard', size: [9, 9, 9],
  ...(attach ? { attach } : {})
});

function circuitPlan(parts, wires) {
  return validatePlan({
    title: 'test', summary: '',
    steps: parts.map(part => ({ room: 'electronics', action: 'solder', say: 'x', seconds: 3, part })),
    wires
  }, 'test');
}
const faultsOf = list => list.filter(f => f.severity === 'fault');
const has = (list, re) => list.some(f => re.test(f.id));

/* The circuit everything else is measured against: a torch that works. */
const TORCH = circuitPlan(
  [P('board', 'board'), P('battery', 'battery', 9), P('switch', 'switch'),
    P('470Ω', 'resistor', 470), P('LED', 'led')],
  [{ from: '1.+', to: '2.a' }, { from: '2.b', to: '3.a' }, { from: '3.b', to: '4.+' }, { from: '4.-', to: '1.-' }]
);

/* ================================================================== */
/* the parts bin                                                       */
/* ================================================================== */
check('a component is made of what a component is made of', () => {
  const parts = planParts(TORCH);
  const r = parts[3];
  assert(r.shape === 'cylinder', `a resistor came out as a ${r.shape}`);
  assert(r.material === 'plastic', `a resistor made of ${r.material}`);
  assert(r.size[1] < 0.4, `a 9m resistor: ${r.size}`);
  assert(r.value === 470, `the value was lost: ${r.value}`);
});

check('every component in the catalogue is usable', () => {
  for (const id of COMPONENT_IDS) {
    const c = COMPONENTS[id];
    assert(Array.isArray(c.pins), `${id} has no pins`);
    assert(c.body?.size?.length === 3, `${id} has no body`);
    assert(bodyFor(id), `${id} has no body when asked for one`);
    assert(isComponent(id) && isComponent(id.toUpperCase()), `${id} is not recognised`);
    for (const pin of c.pins) {
      const off = pinOffset(id, pin);
      assert(off.length === 3 && off.every(Number.isFinite), `${id}.${pin} has no place to land a wire`);
    }
  }
  assert(!isComponent('flange') && !isComponent(''), 'made-up components are being accepted');
});

/* ================================================================== */
/* the netlist                                                         */
/* ================================================================== */
check('anything wired together is one piece of copper', () => {
  const parts = planParts(TORCH);
  const nl = netlist(parts, TORCH.wires);
  assert(nl.comps.length === 4, `${nl.comps.length} components — the board has no pins and should not be one`);
  // battery+ and switch a are the same net; battery- and LED- are another
  assert(nl.netOf('1.+') === nl.netOf('2.a'), 'a wire did not join two pins');
  assert(nl.netOf('1.-') === nl.netOf('4.-'), 'the return is not one net');
  assert(nl.netOf('1.+') !== nl.netOf('1.-'), 'the two sides of the battery are the same net');
});

check('a wire to a pin that does not exist is dropped, not invented', () => {
  const parts = planParts(TORCH);
  const w = validateWires([
    { from: '1.+', to: '2.a' },      // fine
    { from: '1.z', to: '2.a' },      // no such pin
    { from: '9.+', to: '2.a' },      // no such part
    { from: '0.+', to: '2.a' },      // the board has no pins
    { from: '1.+', to: '1.+' },      // to itself
    { from: '2.a', to: '1.+' }       // the same wire backwards
  ], parts);
  assert(w.length === 1, `${w.length} wires survived: ${JSON.stringify(w)}`);
  assert(w[0].from === '1.+' && w[0].to === '2.a', JSON.stringify(w[0]));
});

check('a wire written as an object works as well as one written as a string', () => {
  const parts = planParts(TORCH);
  const w = validateWires([{ from: { part: 1, pin: '+' }, to: { part: 2, pin: 'A' } }], parts);
  assert(w.length === 1 && w[0].to === '2.a', `models writing objects are being dropped: ${JSON.stringify(w)}`);
});

/* ================================================================== */
/* the arithmetic                                                      */
/* ================================================================== */
check('Ohm gets his due', () => {
  const sol = solveCircuit(planParts(TORCH), TORCH.wires);
  assert(sol.ok, sol.why);
  near(sol.resistance, 470, 0.001, 'the loop resistance');
  near(sol.drop, 2, 0.001, "the LED's forward drop");
  // (9 - 2) / 470 = 14.89mA, worked by hand
  near(sol.current, 0.014893, 1e-5, 'the current');
  assert(sol.path.map(c => c.component).join(',') === 'switch,resistor,led',
    `it went round the wrong way: ${sol.path.map(c => c.name)}`);
});

check('a bigger resistor means less current, and the sums stay honest', () => {
  const p = circuitPlan(
    [P('board', 'board'), P('battery', 'battery', 9), P('1kΩ', 'resistor', 1000), P('LED', 'led')],
    [{ from: '1.+', to: '2.a' }, { from: '2.b', to: '3.+' }, { from: '3.-', to: '1.-' }]
  );
  const sol = solveCircuit(planParts(p), p.wires);
  near(sol.current, 0.007, 1e-5, '(9-2)/1000');
});

check('a motor on a 9V battery draws what a motor on a 9V battery draws', () => {
  const p = circuitPlan(
    [P('board', 'board'), P('battery', 'battery', 9), P('motor', 'motor', 40)],
    [{ from: '1.+', to: '2.+' }, { from: '2.-', to: '1.-' }]
  );
  const sol = solveCircuit(planParts(p), p.wires);
  near(sol.current, 0.225, 1e-6, '9V / 40Ω');
});

check('preferred values, because that is what is in the drawer', () => {
  assert(nearestE12(427) === 470, nearestE12(427));
  assert(nearestE12(95) === 100, nearestE12(95));
  assert(nearestE12(4700) === 4700, nearestE12(4700));
  assert(nearestE12(0) === 220 && nearestE12(NaN) === 220, 'nonsense should fall back to something sane');
});

/* ================================================================== */
/* what is wrong with it — each fired, then kept quiet                 */
/* ================================================================== */
check('a working torch is left alone', () => {
  const f = analyseCircuit(planParts(TORCH), TORCH.wires);
  assert(!faultsOf(f).length, `it invented faults in a working circuit: ${faultsOf(f).map(x => x.title)}`);
  assert(f.some(x => x.id === 'runtime'), 'it did not say how long the battery lasts');
});

check('an LED with nothing limiting it is the fault it deserves to be', () => {
  const p = circuitPlan(
    [P('board', 'board'), P('battery', 'battery', 9), P('LED', 'led')],
    [{ from: '1.+', to: '2.+' }, { from: '2.-', to: '1.-' }]
  );
  const f = analyseCircuit(planParts(p), p.wires);
  const led = f.find(x => x.id.startsWith('led-'));
  assert(led && led.severity === 'fault', `no LED fault: ${f.map(x => x.id)}`);
  assert(/470Ω/.test(led.gain), `it should size the resistor for 9V: "${led.gain}"`);
  // and it says it once, not twice
  assert(!has(f, /^imax-/), 'the same fault was reported twice');
});

check('an LED with a resistor is not nagged about it', () => {
  assert(!has(analyseCircuit(planParts(TORCH), TORCH.wires), /^led-/), 'a properly limited LED was flagged');
});

check('a battery wired to itself is a short', () => {
  const p = circuitPlan([P('board', 'board'), P('battery', 'battery', 9)], [{ from: '1.+', to: '1.-' }]);
  const f = analyseCircuit(planParts(p), p.wires);
  assert(has(f, /^short/), `a dead short was not noticed: ${f.map(x => x.id)}`);
});

check('a loop through nothing but wire is also a short', () => {
  const p = circuitPlan(
    [P('board', 'board'), P('battery', 'battery', 9), P('switch', 'switch')],
    [{ from: '1.+', to: '2.a' }, { from: '2.b', to: '1.-' }]
  );
  const f = analyseCircuit(planParts(p), p.wires);
  assert(has(f, /^short/), `a switch straight across the battery was allowed: ${f.map(x => x.id)}`);
});

check('a circuit that does not close is a fault, and it says which pin is loose', () => {
  const p = circuitPlan(
    [P('board', 'board'), P('battery', 'battery', 9), P('470Ω', 'resistor', 470), P('LED', 'led')],
    [{ from: '1.+', to: '2.a' }, { from: '2.b', to: '3.+' }]     // never comes back
  );
  const f = analyseCircuit(planParts(p), p.wires);
  const open = f.find(x => x.id === 'open');
  assert(open, `an open circuit was not noticed: ${f.map(x => x.id)}`);
  assert(/LED|-/.test(open.why), `it did not say what was loose: "${open.why}"`);
});

check('a closed circuit is not called open', () => {
  assert(!has(analyseCircuit(planParts(TORCH), TORCH.wires), /^open/), 'a working torch was called open');
});

check('nothing to power it is a fault on its own', () => {
  const p = circuitPlan(
    [P('board', 'board'), P('470Ω', 'resistor', 470), P('LED', 'led')],
    [{ from: '1.a', to: '2.+' }]
  );
  const f = analyseCircuit(planParts(p), p.wires);
  assert(f.length === 1 && f[0].id === 'no-supply',
    `it should say one thing — that there is no battery: ${f.map(x => x.id)}`);
});

check('a resistor asked to dissipate more than it can is called out', () => {
  // 12V across 10Ω is 14W in a quarter-watt part
  const p = circuitPlan(
    [P('board', 'board'), P('supply', 'supply', 12), P('10Ω', 'resistor', 10)],
    [{ from: '1.+', to: '2.a' }, { from: '2.b', to: '1.-' }]
  );
  const f = analyseCircuit(planParts(p), p.wires);
  const w = f.find(x => x.id.startsWith('watts-'));
  assert(w && w.severity === 'fault', `14W in a 0.25W resistor was allowed: ${f.map(x => x.id)}`);
  assert(/Ω/.test(w.gain), `no replacement value offered: "${w.gain}"`);
});

check('a resistor inside its rating is not', () => {
  // 9V, 470Ω, LED — about 100mW
  assert(!has(analyseCircuit(planParts(TORCH), TORCH.wires), /^watts-/), 'a 100mW resistor was called too hot');
});

check('a pin wired to nothing is mentioned, gently', () => {
  const p = circuitPlan(
    [P('board', 'board'), P('battery', 'battery', 9), P('470Ω', 'resistor', 470),
      P('LED', 'led'), P('spare', 'capacitor', 100)],
    [{ from: '1.+', to: '2.a' }, { from: '2.b', to: '3.+' }, { from: '3.-', to: '1.-' }]
  );
  const f = analyseCircuit(planParts(p), p.wires);
  const float = f.find(x => x.id.startsWith('float-'));
  assert(float, `an unconnected capacitor was not noticed: ${f.map(x => x.id)}`);
  assert(float.severity === 'improvement', 'a spare part is not a fault, it is waste');
});

check('battery life comes out in units a person would use', () => {
  const f = analyseCircuit(planParts(TORCH), TORCH.wires);
  const rt = f.find(x => x.id === 'runtime');
  assert(/15mA/.test(rt.title), rt.title);
  // 550mAh / 14.9mA = 37 hours
  assert(/3[0-9] hours/.test(rt.gain), `battery life came out as "${rt.gain}"`);
});

/* ================================================================== */
/* the fix has to fix it                                               */
/* ================================================================== */
check('dropping a resistor in front of an LED actually clears the fault', () => {
  const p = circuitPlan(
    [P('board', 'board'), P('battery', 'battery', 9), P('LED', 'led', 0, { to: 0, face: 'top' })],
    [{ from: '1.+', to: '2.+' }, { from: '2.-', to: '1.-' }]
  );
  const before = analyse(p, inspectPlan(p).solved);
  const led = before.find(x => x.id.startsWith('led-'));
  assert(led?.patch, 'no fix offered');

  const fixed = applyFinding(p, led);
  const after = analyseCircuit(planParts(fixed), fixed.wires);
  assert(!has(after, /^led-/), `the LED is still unprotected after the fix: ${after.map(x => x.id)}`);
  assert(!has(after, /^short|^open/), `the fix broke the circuit: ${after.map(x => x.id)}`);

  const sol = solveCircuit(planParts(fixed), fixed.wires);
  assert(sol.ok, sol.why);
  assert(sol.current > 0.005 && sol.current < 0.025,
    `${(sol.current * 1000).toFixed(1)}mA — the fix should land the LED near 15mA`);
});

/* ================================================================== */
/* through the whole pipeline                                          */
/* ================================================================== */
check('a circuit request is routed to electronics, not to jet engines', () => {
  assert(classifyRequest('a circuit that blinks an LED').domain === 'electronics', 'circuit misrouted');
  assert(classifyRequest('a torch with a switch').domain === 'electronics', 'torch misrouted');
  // "motor" is in the propulsion vocabulary — the specific reading has to win
  assert(classifyRequest('a circuit that runs a small motor').domain === 'electronics',
    'a motor circuit was sent to the jet engine sources');
  assert(classifyRequest('a turbofan engine').domain === 'propulsion', 'engines stopped working');
  assert(classifyRequest('a wooden stool').domain === 'making', 'a stool became electronics');
});

check('the offline planner builds a circuit that would actually light', () => {
  for (const ask of ['a torch with a switch', 'a circuit that runs a small motor', 'an alarm buzzer on a 1.5V cell']) {
    const plan = validatePlan(offlinePlan(ask, null), ask);
    const parts = planParts(plan);
    assert(plan.wires?.length, `${ask}: no wires at all`);
    assert(parts.some(p => COMPONENTS[p.component]?.source), `${ask}: nothing to power it`);

    const sol = solveCircuit(parts, plan.wires);
    assert(sol.ok, `${ask}: ${sol.why}`);
    assert(sol.current > 0 && sol.current < 1, `${ask}: ${sol.current}A is not a sane current`);

    const f = analyse(plan, inspectPlan(plan).solved);
    assert(!faultsOf(f).length, `${ask}: built with faults — ${faultsOf(f).map(x => x.title)}`);
  }
});

check('the work happens at the electronics bench', () => {
  const plan = validatePlan(offlinePlan('a torch with a switch', null), 'torch');
  const rooms = new Set(plan.steps.map(s => s.room));
  assert(rooms.has('electronics'), `it was built in ${[...rooms].join(', ')}`);
  const soldering = plan.steps.filter(s => ['solder', 'breadboard', 'crimp', 'strip_wire'].includes(s.action));
  assert(soldering.length >= 2, `only ${soldering.length} bench operations`);
  assert(plan.steps.some(s => s.action === 'meter_test'), 'he never checked it with a meter');
});

check('the mechanical rules leave components alone', () => {
  /* A resistor on screen is a 260mm barrel so it can be seen from across
     the shop. Weighed as solid stock that is kilos, and the structural
     rules would spend all day insisting a board cannot hold its own
     components. */
  const plan = validatePlan(offlinePlan('a circuit that runs a small motor', null), 'motor');
  const f = analyse(plan, inspectPlan(plan).solved);
  assert(!has(f, /^load-|^thick-|^slender-/),
    `structural rules fired on a circuit: ${f.filter(x => /^load-|^thick-|^slender-/.test(x.id)).map(x => x.title)}`);
  assert(!has(f, /^tool-/), 'soldering a component was called the wrong tool for the material');
});

check('the planner is told the rules, and the schema lets it obey them', () => {
  const block = electricalBlock('a circuit with an LED');
  assert(/resistor in series/i.test(block), 'the LED rule is missing from the prompt');
  assert(/LOOP/.test(block), 'the loop rule is missing');
  assert(/"wires"/.test(block), 'it never says how to write a wire');
  assert(electricalBlock('a wooden stool') === '', 'a stool got a wiring lecture');

  const props = PLAN_SCHEMA.properties;
  assert(props.wires, 'the schema has no wires, so a constrained decoder cannot emit any');
  assert(props.steps.items.properties.part.properties.component.enum.includes('resistor'),
    'the component enum is missing from the schema');
});

check('it can be described in a sentence the critic can read', () => {
  const d = describeCircuit(planParts(TORCH), TORCH.wires);
  assert(/battery.*→.*led/i.test(d.replace(/\n/g, ' ')), d);
  assert(/15mA/.test(d), `no current in the description: ${d}`);
  assert(describeCircuit([], []) === '', 'a build with no electronics described itself anyway');
});

check('a build with no electronics produces no electrical findings', () => {
  const plan = validatePlan(offlinePlan('a wooden stool', null), 'stool');
  const f = analyse(plan, inspectPlan(plan).solved);
  assert(!f.some(x => x.kind === 'electrical'), `a stool was given electrical advice: ${f.filter(x => x.kind === 'electrical').map(x => x.title)}`);
  assert(analyseCircuit(planParts(plan), []).length === 0, 'nothing electrical should come back');
});

/* ================================================================== */
console.log(out.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
