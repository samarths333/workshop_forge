/* =====================================================================
   The mechanical engineer.

   Two things are being checked here and they are not the same thing.

   The first is ARITHMETIC, against engines that exist. A 2JZ is 2997cc and
   a Merlin is 27 litres, and anybody can look that up — so if the sums in
   engine.js come out anywhere else, they are wrong, and no amount of the
   output looking like an engine makes up for it. Those are the fixtures.

   The second is the FAULT RULES, and they are held to the standard the
   optimiser is held to: every rule is fired once on a build that has the
   fault and once on a build that does not. A fault rule that cannot be
   quiet is worse than no rule at all, because the first time it cries wolf
   on a real engine it gets ignored, and the time it was right goes with it.
   ===================================================================== */

import {
  ENGINE_KINDS, LAYOUTS, ICE_REFERENCES, TURBOFAN_REFERENCE, EMOTOR_REFERENCES,
  GAS, sizeICE, sizeTurbofan, sizeMotor, sizeEngine, engineParts, ENGINE_ROLES,
  analyseEngine, validateEngine, specFromRequest, describeEngine, engineBlock,
  engineMotion, pistonAt, pistonPhase, firingOrder, firingAngles,
  annulusArea, hubDiameterFromMean, tipDiameterFromMean, scaleFor, ENGINE_RE
} from '../renderer/engine.js';
import { validatePlan, planParts, offlinePlan } from '../renderer/agent.js';
import { inspectPlan } from '../renderer/critic.js';
import { analyse, applyFinding } from '../renderer/optimize.js';
import { MATERIALS, SHAPES } from '../renderer/assembly.js';
import { ShopFloor } from '../renderer/shopfloor.js';
import { roleForMaterial, roleById } from '../renderer/roles.js';

let pass = 0, fail = 0;
const out = [];
const check = (name, fn) => {
  try { fn(); pass++; out.push(`  ok    ${name}`); }
  catch (e) { fail++; out.push(`  FAIL  ${name}\n          ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const near = (a, b, tol, m) => assert(Math.abs(a - b) <= tol, `${m} (${a} vs ${b})`);

/* A plan carrying an engine, as the shop would have it after validation. */
const enginePlan = spec => {
  const engine = validateEngine(spec);
  const parts = engineParts(sizeEngine(engine));
  return validatePlan({
    title: 'engine', summary: 'test', engine,
    steps: parts.map(p => ({
      room: 'machining', action: 'lathe_turn', say: 'making it', seconds: 4,
      part: { ...p, size: [9, 9, 9], material: 'cardboard', shape: 'box' }   // deliberately wrong
    })).concat([{ room: 'finished', action: 'present', say: 'done', seconds: 3 }])
  }, 'engine');
};
const faultsOf = f => f.filter(x => x.severity === 'fault');
const has = (list, re) => list.some(f => re.test(f.title) || re.test(f.id));

/* ------------------------------------------------------------------ */
/* the catalogue                                                       */
/* ------------------------------------------------------------------ */
check('every reference engine in the catalogue is complete and sizes', () => {
  for (const [id, r] of Object.entries(ICE_REFERENCES)) {
    assert(LAYOUTS[r.layout], `${id} has layout "${r.layout}", which is not a layout`);
    for (const k of ['bore', 'stroke', 'rod', 'cylinders', 'redline', 'compressionRatio']) {
      assert(Number.isFinite(r[k]) && r[k] > 0, `${id} has no ${k}`);
    }
    const s = sizeICE(r);
    assert(s.displacement > 0 && s.compressionRatio > 1, `${id} sized to nonsense`);
    assert(s.firingOrder.length === r.cylinders, `${id} fires ${s.firingOrder.length} of ${r.cylinders} cylinders`);
  }
  for (const [id, m] of Object.entries(EMOTOR_REFERENCES)) {
    const s = sizeMotor(m);
    assert(s.rotorOD > 0 && s.noLoadRpm > 0, `${id} sized to nonsense`);
  }
  assert(ENGINE_KINDS.length === 3, 'the three families are not all there');
});

/* The whole point of lifting the numbers rather than inventing them. */
check('displacement comes out at what these engines actually are', () => {
  near(sizeICE(ICE_REFERENCES.toyota_2jz).displacement, 2997, 2, '2JZ is not 2997cc');
  near(sizeICE(ICE_REFERENCES.hayabusa).displacement, 1340, 2, 'a Hayabusa is not 1340cc');
  near(sizeICE(ICE_REFERENCES.gm_ls).litres, 5.33, 0.02, 'the LS is not 5.3 litres');
  near(sizeICE(ICE_REFERENCES.ferrari_f136).litres, 4.5, 0.02, 'the F136 is not 4.5 litres');
  near(sizeICE(ICE_REFERENCES.merlin_v12).litres, 27.0, 0.05, 'a Merlin is not 27 litres');
  near(sizeICE(ICE_REFERENCES.subaru_ej25).displacement, 2457, 2, 'an EJ25 is not 2457cc');
});

check('compression ratio and chamber volume are the same fact stated twice', () => {
  const e = sizeICE({ ...ICE_REFERENCES.toyota_2jz });
  near(e.compressionRatio, 10.5, 0.05, 'the quoted ratio was not reproduced');
  // and going the other way: give it the chamber, get the ratio back
  const byChamber = sizeICE({ ...ICE_REFERENCES.toyota_2jz, compressionRatio: undefined, chamber: e.chamber });
  near(byChamber.compressionRatio, e.compressionRatio, 0.02, 'chamber and ratio disagree');
  // the arithmetic itself: swept 500cc in a 50cc chamber is 11:1
  near(sizeICE({ bore: 100, stroke: 63.66, chamber: 50, cylinders: 1, layout: 'single' }).compressionRatio,
    11, 0.1, 'the compression ratio is not (swept + chamber) / chamber');
});

check('the rotating assembly stacks up', () => {
  const e = sizeICE(ICE_REFERENCES.toyota_2jz);
  near(e.crankThrow, 43, 0.01, 'the throw is not half the stroke');
  near(e.deckHeight, 43 + 142 + 32.8, 0.05, 'deck height is not throw + rod + compression height');
  near(e.rodStrokeRatio, 142 / 86, 0.01, 'the rod/stroke ratio is wrong');
  near(e.boreStrokeRatio, 1, 0.001, 'a square engine did not come out square');
  // mean piston speed: 86mm at 6000rpm is 2 · 0.086 · 100 = 17.2 m/s
  near(e.meanPistonSpeed, 17.2, 0.05, 'mean piston speed is not 2 · stroke · rpm / 60');
});

/* ------------------------------------------------------------------ */
/* firing                                                              */
/* ------------------------------------------------------------------ */
check('every firing order fires every cylinder exactly once', () => {
  for (const [layout, counts] of [['inline', [3, 4, 5, 6]], ['vee', [6, 8, 10, 12]], ['flat', [4, 6]], ['radial', [5, 7, 9]]]) {
    for (const n of counts) {
      const o = firingOrder(layout, n);
      assert(o.length === n, `${layout}${n} fires ${o.length} times`);
      assert(new Set(o).size === n, `${layout}${n} fires a cylinder twice: ${o}`);
      assert(o.every(c => c >= 1 && c <= n), `${layout}${n} fires a cylinder that is not there: ${o}`);
    }
  }
  assert(firingOrder('inline', 6).join('-') === '1-5-3-6-2-4', 'an inline six does not fire 1-5-3-6-2-4');
  assert(firingOrder('vee', 8).join('-') === '1-8-7-2-6-5-4-3', 'the V8 order is not the one the engine uses');
});

check('an even-fire engine fires at even intervals', () => {
  const a = firingAngles('inline', 4);
  const sorted = [...a].sort((x, y) => x - y);
  for (let i = 1; i < sorted.length; i++) {
    near(sorted[i] - sorted[i - 1], 180, 0.1, 'a four does not fire every 180 crank degrees');
  }
  near(firingAngles('vee', 8).sort((x, y) => x - y)[1], 90, 0.1, 'a V8 does not fire every 90 degrees');
});

/* ------------------------------------------------------------------ */
/* the slider-crank                                                    */
/* ------------------------------------------------------------------ */
check('the piston is at the top at nought and the bottom at a half turn', () => {
  const r = 43, l = 142;
  near(pistonAt(0, r, l), r + l, 1e-9, 'top dead centre is not throw + rod');
  near(pistonAt(Math.PI, r, l), l - r, 1e-9, 'bottom dead centre is not rod - throw');
  near(pistonPhase(0, r, l), 1, 1e-9, 'TDC did not come out as 1');
  near(pistonPhase(Math.PI, r, l), 0, 1e-9, 'BDC did not come out as 0');
});

check('the piston travel is not a sine wave', () => {
  /* The exact slider-crank is asymmetric: at 90 degrees the piston is
     BELOW the halfway point, because the rod is swinging. A sine
     approximation puts it exactly halfway, and that difference is the
     whole reason short rods are hard on an engine. */
  const r = 43, l = 142;
  const quarter = pistonPhase(Math.PI / 2, r, l);
  assert(quarter < 0.5, `at 90 degrees the piston is at ${quarter}, which is a sine wave, not a crank`);
  assert(quarter > 0.35, 'the asymmetry is far larger than a real rod would give');
  // and a longer rod is closer to symmetric
  assert(pistonPhase(Math.PI / 2, r, l * 2) > quarter, 'a longer rod did not reduce the asymmetry');
});

/* ------------------------------------------------------------------ */
/* the turbofan                                                        */
/* ------------------------------------------------------------------ */
check('annulus area is mass flow over density times axial velocity', () => {
  /* Worked by hand off the same constants: at the HPC exit, P0 1468830Pa
     and T0 758.17K, the flow is doing 190 m/s. */
  const P0 = 1468830, T0 = 758.17, V = 190;
  const T = T0 - (V * V) / (2 * GAS.cp);
  const M = V / Math.sqrt(GAS.gamma * GAS.R * T);
  const rho = (P0 / (GAS.R * T0)) * (1 + ((GAS.gamma - 1) / 2) * M * M) ** (-1 / (GAS.gamma - 1));
  near(annulusArea(20.5, P0, T0, V), 20.5 / (rho * V), 1e-9, 'the area is not ṁ/(ρVx)');
  // and it moves the right way: more flow needs more annulus
  assert(annulusArea(41, P0, T0, V) > annulusArea(20.5, P0, T0, V), 'twice the flow did not need more annulus');
});

check('hub and tip come back to the annulus they were derived from', () => {
  const area = 0.12, mean = 0.5;
  const hub = hubDiameterFromMean(mean, area), tip = tipDiameterFromMean(mean, area);
  near((hub + tip) / 4, mean, 1e-9, 'the mean of hub and tip is not the mean radius');
  near(Math.PI * ((tip / 2) ** 2 - (hub / 2) ** 2), area, 1e-6, 'the annulus does not have the area it was built from');
});

check('the turbofan sizes to something of the right class', () => {
  const t = sizeTurbofan({});
  near(t.totalMassFlow, 20.5 * 8, 0.1, 'the bypass ratio did not set the total flow');
  near(t.bypassMassFlow, 20.5 * 7, 0.1, 'the bypass stream is wrong');
  // tip speed: Mach 1.3 in standard air is about 442 m/s
  near(t.tipSpeed, 1.3 * Math.sqrt(1.4 * 287 * 288.15), 0.5, 'the fan tip speed is not the tip Mach');
  near(t.fanRpm, (t.tipSpeed / (t.fanDiameter / 2000)) * 60 / (2 * Math.PI), 1, 'shaft speed does not follow from tip speed');
  assert(t.stations.every(s => s.tipDiameter > s.hubDiameter), 'a station has its tip inside its hub');
  assert(t.stations.find(s => s.id === 'hpc').stages >= 8, 'a 16:1 compressor came out with too few stages');
  assert(t.stations.find(s => s.id === 'lpc').stages <= 3, 'the booster came out with too many stages');
  assert(t.thrust > 20 && t.thrust < 200, `${t.thrust}kN is not a sane thrust for 164 kg/s`);
});

check('the cycle closes — the turbines take back more than the compressors put in', () => {
  const t = sizeTurbofan({});
  assert(t.turbineWork > t.compressorWork, 'there is nothing left over to turn the fan');
  assert(t.fanWork > 0 && t.impliedFanPR > 1.2,
    `the surplus only buys a fan pressure ratio of ${t.impliedFanPR}`);
});

/* ------------------------------------------------------------------ */
/* the motor                                                           */
/* ------------------------------------------------------------------ */
check('a motor sizes, and cogging follows the slot/pole combination', () => {
  const good = sizeMotor(EMOTOR_REFERENCES.outrunner_2814);
  const bad = sizeMotor(EMOTOR_REFERENCES.inrunner_540);
  assert(good.coggingSteps === 84, `12/14 should cog 84 times a turn, not ${good.coggingSteps}`);
  assert(bad.coggingSteps === 12, `12/4 should cog 12 times a turn, not ${bad.coggingSteps}`);
  near(good.noLoadRpm, 700 * 14.8, 1, 'no-load speed is not Kv × volts');
  near(good.torqueConstant, 9.5493 / 700, 1e-4, 'the torque constant is not 9.5493/Kv');
  assert(good.rotorOD > good.statorOD, 'an outrunner rotor is not outside its stator');
  assert(bad.rotorOD < bad.statorID, 'an inrunner rotor is not inside its bore');
});

/* ------------------------------------------------------------------ */
/* parts                                                               */
/* ------------------------------------------------------------------ */
check('every engine turns into parts the solver can actually build', () => {
  for (const spec of [ICE_REFERENCES.gm_ls, ICE_REFERENCES.radial_9, TURBOFAN_REFERENCE, EMOTOR_REFERENCES.outrunner_2814]) {
    const parts = engineParts(sizeEngine(validateEngine(spec)));
    assert(parts.length >= 4, 'an engine came out as fewer than four parts');
    parts.forEach((p, i) => {
      assert(SHAPES.includes(p.shape), `${p.name} is a "${p.shape}", which nothing can draw`);
      assert(MATERIALS.includes(p.material), `${p.name} is made of "${p.material}", which does not exist`);
      assert(ENGINE_ROLES.includes(p.engine_role), `${p.name} has no engine_role`);
      assert(p.size.every(v => v > 0.005 && v < 3), `${p.name} is ${p.size} — off the pedestal`);
      if (i === 0) assert(!p.attach, 'the first part of an engine is bolted to something that does not exist yet');
      else assert(p.attach && p.attach.to < i, `${p.name} is bolted forwards, to ${p.attach?.to}`);
    });
  }
});

check('the geometry is the shop\'s, not the model\'s', () => {
  /* Every part in this plan was handed in as a 9m cardboard box. If any
     of that survives, the override is not working — and it is the same
     override, for the same reason, as a resistor's body. */
  const plan = enginePlan(ICE_REFERENCES.toyota_2jz);
  for (const p of planParts(plan)) {
    if (!p.engine_role) continue;
    assert(p.material !== 'cardboard', `${p.name} is still cardboard`);
    assert(p.size.every(v => v < 2), `${p.name} kept the size it was handed in at`);
  }
  assert(planParts(plan).some(p => p.material === 'alloy'), 'nothing came out in alloy');
});

check('a bigger engine is a bigger engine, and still fits the pedestal', () => {
  const small = sizeICE(ICE_REFERENCES.hayabusa);
  const big = sizeICE(ICE_REFERENCES.merlin_v12);
  assert(big.blockLength > small.blockLength, 'a Merlin is not longer than a Hayabusa');
  // but on the pedestal they are both about the same size, because the
  // scale is what changes — a 27 litre V12 is not shown 20 times bigger
  for (const e of [small, big]) {
    const parts = engineParts(e);
    const tallest = Math.max(...parts.map(p => Math.max(...p.size)));
    assert(tallest > 0.2 && tallest < 1.6, `${e.name} came out ${tallest} across on the pedestal`);
  }
  assert(scaleFor(big) < scaleFor(small), 'the bigger engine was not scaled down further');
});

check('the whole engine stands up when it is solved', () => {
  for (const spec of [ICE_REFERENCES.gm_ls, TURBOFAN_REFERENCE, EMOTOR_REFERENCES.industrial_bldc]) {
    const plan = enginePlan(spec);
    const report = inspectPlan(plan);
    assert(report.solved.instances.length >= 4, 'the solver lost most of the engine');
    const lowest = Math.min(...report.solved.instances.map(i => i.pos[1] - i.half[1]));
    assert(Math.abs(lowest) < 0.05, `the engine floats ${lowest.toFixed(3)} off the pedestal`);
  }
});

/* ------------------------------------------------------------------ */
/* what is wrong with it — every rule fired, then kept quiet            */
/* ------------------------------------------------------------------ */
check('a supercharged engine is judged against its own compression band', () => {
  /* A Merlin is 6:1 and that is correct — it is blown, so the compression
     ratio is deliberately low. Judged against a road car's band it fails,
     and an engineer who fails a Merlin is an engineer nobody listens to. */
  const merlin = analyseEngine(enginePlan(ICE_REFERENCES.merlin_v12));
  assert(!has(faultsOf(merlin), /compression/i), 'a supercharged V12 was failed for running 6:1');
  // and the same ratio without the blower IS a fault
  assert(has(faultsOf(analyseEngine(enginePlan({ ...ICE_REFERENCES.merlin_v12, induction: 'na' }))), /compression/i),
    '6:1 passed on a naturally aspirated engine');
});

check('a real engine is left alone', () => {
  for (const [id, r] of Object.entries(ICE_REFERENCES)) {
    const f = analyseEngine(enginePlan(r));
    assert(!faultsOf(f).length, `it invented faults in a ${id}: ${faultsOf(f).map(x => x.title)}`);
  }
  const t = analyseEngine(enginePlan(TURBOFAN_REFERENCE));
  assert(!faultsOf(t).length, `it invented faults in the reference turbofan: ${faultsOf(t).map(x => x.title)}`);
  const m = analyseEngine(enginePlan(EMOTOR_REFERENCES.outrunner_2814));
  assert(!faultsOf(m).length, `it invented faults in a stock outrunner: ${faultsOf(m).map(x => x.title)}`);
});

check('it reports what the engine is even when nothing is wrong', () => {
  const f = analyseEngine(enginePlan(ICE_REFERENCES.toyota_2jz));
  assert(f.some(x => x.id === 'capacity'), 'it did not say what the engine was');
  assert(analyseEngine(enginePlan(TURBOFAN_REFERENCE)).some(x => x.id === 'thrust'), 'it did not say how much thrust');
  assert(analyseEngine({}).length === 0, 'a plan with no engine produced findings');
});

check('a compression ratio that detonates is caught, and a normal one is not', () => {
  const bad = analyseEngine(enginePlan({ ...ICE_REFERENCES.toyota_2jz, compressionRatio: undefined, chamber: 12 }));
  assert(has(faultsOf(bad), /compression/i), 'a 42:1 petrol engine passed');
  const ok = analyseEngine(enginePlan({ ...ICE_REFERENCES.toyota_2jz }));
  assert(!has(faultsOf(ok), /compression/i), 'a 10.5:1 petrol engine was failed');
  // and a diesel is judged against the diesel band
  const diesel = analyseEngine(enginePlan({ ...ICE_REFERENCES.toyota_2jz, compressionRatio: 18, fuel: 'diesel' }));
  assert(!has(faultsOf(diesel), /compression/i), '18:1 was failed on a diesel');
  assert(has(faultsOf(analyseEngine(enginePlan({ ...ICE_REFERENCES.toyota_2jz, compressionRatio: 18 }))), /compression/i),
    '18:1 passed on petrol');
});

check('a piston speed nothing survives is caught, and a fast engine is not', () => {
  const bad = analyseEngine(enginePlan({ ...ICE_REFERENCES.merlin_v12, redline: 9000 }));
  assert(has(faultsOf(bad), /piston/i), 'a 6 inch stroke at 9000rpm passed');
  const ok = analyseEngine(enginePlan(ICE_REFERENCES.ferrari_f136));
  assert(!has(faultsOf(ok), /piston/i), 'a 9000rpm race V8 with an 81mm stroke was failed');
});

check('a short rod is flagged, a normal one is not', () => {
  const bad = analyseEngine(enginePlan({ ...ICE_REFERENCES.toyota_2jz, rod: 100 }));
  assert(has(bad, /rod/i), 'a rod/stroke of 1.16 passed');
  assert(!has(analyseEngine(enginePlan(ICE_REFERENCES.toyota_2jz)), /rod ratio|rods are short/i), 'a 1.65 rod ratio was flagged');
});

check('a cylinder count that does not fit the layout is caught', () => {
  const oddV = analyseEngine(enginePlan({ kind: 'ice', layout: 'vee', cylinders: 7, bore: 86, stroke: 86, rod: 142, compressionRatio: 10 }));
  // validateEngine already rounds a V up to an even count, so the fault
  // only fires when something reached analyse without it — check the clamp
  assert(validateEngine({ kind: 'ice', layout: 'vee', cylinders: 7 }).cylinders === 8, 'a V7 was allowed through');
  assert(validateEngine({ kind: 'ice', layout: 'radial', cylinders: 8 }).cylinders === 9, 'an even single-row radial was allowed through');
  assert(!faultsOf(oddV).some(f => f.id === 'bank-count'), 'the clamp and the rule disagree');
});

check('an engine with no crank, no head or no combustor is caught', () => {
  const strip = (spec, role) => {
    const plan = enginePlan(spec);
    plan.steps = plan.steps.filter(s => s.part?.engine_role !== role);
    return analyseEngine(plan);
  };
  assert(has(faultsOf(strip(ICE_REFERENCES.toyota_2jz, 'crank')), /crankshaft/i), 'an engine with no crank passed');
  assert(has(faultsOf(strip(ICE_REFERENCES.toyota_2jz, 'head')), /open at the top/i), 'an engine with no head passed');
  assert(has(faultsOf(strip(TURBOFAN_REFERENCE, 'combustor')), /burning/i), 'a turbofan with no combustor passed');
  // and none of those fire on the complete engine
  const whole = faultsOf(analyseEngine(enginePlan(ICE_REFERENCES.toyota_2jz)));
  assert(!whole.length, `a complete engine was failed: ${whole.map(f => f.title)}`);
});

check('a fan that will not clear the ground is caught, a normal one is not', () => {
  const big = analyseEngine(enginePlan({ ...TURBOFAN_REFERENCE, fanDiameter: 4200 }));
  assert(has(faultsOf(big), /ground/i), 'a 4.2m fan passed');
  assert(!has(analyseEngine(enginePlan(TURBOFAN_REFERENCE)), /ground/i), 'a 2.6m fan was failed');
});

check('magnets that do not fit the rotor are caught, and normal ones are not', () => {
  const tight = analyseEngine(enginePlan({ ...EMOTOR_REFERENCES.inrunner_540, magnetThickness: 9 }));
  assert(has(faultsOf(tight), /magnet/i), '9mm magnets in a 13mm rotor passed');
  assert(!has(faultsOf(analyseEngine(enginePlan(EMOTOR_REFERENCES.inrunner_540))), /magnet/i), 'a stock inrunner was failed');
  // and the rotor is always the right side of the stator for its form
  const inr = sizeMotor(EMOTOR_REFERENCES.inrunner_540);
  const outr = sizeMotor(EMOTOR_REFERENCES.outrunner_2814);
  assert(inr.rotorOD < inr.statorID, 'an inrunner rotor is not inside its bore');
  assert(outr.rotorOD > outr.statorOD, 'an outrunner rotor is not outside its stator');
});

check('a cogging slot/pole combination is flagged and a good one is not', () => {
  assert(has(analyseEngine(enginePlan({ ...EMOTOR_REFERENCES.outrunner_2814, poles: 6 })), /cog/i), '12/6 passed');
  assert(!has(analyseEngine(enginePlan(EMOTOR_REFERENCES.outrunner_2814)), /cog/i), '12/14 was flagged');
});

/* ------------------------------------------------------------------ */
/* the fix has to fix it                                               */
/* ------------------------------------------------------------------ */
check('applying an engine patch clears the finding and re-sizes the parts', () => {
  const plan = enginePlan({ ...ICE_REFERENCES.toyota_2jz, compressionRatio: undefined, chamber: 12 });
  const before = analyseEngine(plan).find(f => f.id === 'cr');
  assert(before?.patch, 'the compression ratio fault came with no fix');
  const after = applyFinding(plan, before);
  assert(after !== plan, 'the patch did nothing');
  assert(!analyseEngine(after).some(f => f.id === 'cr'), 'the fix did not clear the fault');
  assert(after.engine.chamber !== plan.engine.chamber, 'the spec was not changed');
});

check('a change to the spec re-sizes every part that came off it', () => {
  const plan = enginePlan(ICE_REFERENCES.toyota_2jz);
  /* Compared as PROPORTIONS, not as absolutes. The assembly is rescaled to
     the pedestal, so an engine that is bigger in every dimension at once
     looks identical — which is correct, and is why the check has to be on
     the shape of it. A bigger bore against the same stroke makes the block
     longer and squatter. */
  const aspect = p => {
    const blk = planParts(p).find(x => x.engine_role === 'block');
    return blk.size[0] / blk.size[1];
  };
  const wider = applyFinding(plan, { patch: { kind: 'edit-spec', set: { bore: 120 } } });
  assert(wider.engine.bore === 120, 'the bore did not change');
  assert(aspect(wider) > aspect(plan) * 1.05, 'the block did not follow the bore');
  const longer = applyFinding(plan, { patch: { kind: 'edit-spec', set: { stroke: 130 } } });
  assert(aspect(longer) < aspect(plan) * 0.95, 'the block did not follow the stroke');
  // and an impossible value is clamped rather than accepted
  const silly = applyFinding(plan, { patch: { kind: 'edit-spec', set: { bore: 99999 } } });
  assert(silly.engine.bore <= 400, 'the spec accepted a 100 metre bore');
});

check('engine findings reach the bench beside everything else', () => {
  const plan = enginePlan({ ...ICE_REFERENCES.toyota_2jz, compressionRatio: undefined, chamber: 12 });
  const found = analyse(plan, inspectPlan(plan).solved);
  assert(found.some(f => f.kind === 'mechanical'), 'no mechanical finding made it into the bench list');
  for (const f of found) {
    assert(['fault', 'improvement', 'note'].includes(f.severity), `${f.id} has severity "${f.severity}", which the panel cannot style`);
  }
});

check('an engine part is exempt from the structural rules', () => {
  /* A crankshaft is a long thin rod and a compressor disc is a lump of
     stock with nothing sitting on it. Both are correct, and the optimiser
     must not spend its list saying otherwise — same exemption components
     get, for the same reason. */
  const plan = enginePlan(TURBOFAN_REFERENCE);
  const found = analyse(plan, inspectPlan(plan).solved).filter(f => f.kind !== 'mechanical');
  const noise = found.filter(f => /slender|dead stock|thinner|doing no work/i.test(f.title));
  assert(!noise.length, `the optimiser complained about the engine itself: ${noise.map(f => f.title)}`);
});

/* ------------------------------------------------------------------ */
/* motion                                                              */
/* ------------------------------------------------------------------ */
check('what turns, turns — and the pistons follow the firing order', () => {
  const plan = enginePlan(ICE_REFERENCES.gm_ls);
  const motion = engineMotion(plan);
  const parts = planParts(plan);
  assert(motion.length, 'nothing on a V8 moves');
  const spins = motion.filter(m => m.kind === 'spin');
  assert(spins.some(m => parts[m.part].engine_role === 'crank'), 'the crankshaft does not turn');
  const recip = motion.filter(m => m.kind === 'reciprocate');
  assert(recip.length === 2, `a V8 has two banks of pistons, not ${recip.length}`);
  for (const m of recip) {
    assert(m.phases.length === 4, `a bank of a V8 has four pistons, not ${m.phases.length}`);
    assert(m.travel > 0, 'the pistons have no travel');
  }
  // the two banks are on DIFFERENT cylinders, or the second bank is a copy
  assert(recip[0].phases.join() !== recip[1].phases.join(), 'both banks fire on the same four cylinders');
  assert(new Set([...recip[0].phases, ...recip[1].phases]).size === 8, 'eight cylinders do not have eight phases');
});

check('a turbofan turns on two spools and a motor turns its rotor', () => {
  const t = engineMotion(enginePlan(TURBOFAN_REFERENCE));
  const rpms = new Set(t.map(m => Math.round(m.rpm)));
  assert(t.length >= 5, 'most of the turbofan is stationary');
  assert(rpms.size === 2, `a two-spool engine turned at ${rpms.size} speeds`);
  assert(t.every(m => m.kind === 'spin'), 'something in a turbofan is reciprocating');

  const m = engineMotion(enginePlan(EMOTOR_REFERENCES.outrunner_2814));
  assert(m.length >= 1 && m.every(x => x.kind === 'spin'), 'the motor does not turn');
  assert(engineMotion({}).length === 0, 'a plan with no engine produced motion');
});

/* ------------------------------------------------------------------ */
/* asking for one                                                      */
/* ------------------------------------------------------------------ */
check('a request turns into the engine somebody meant', () => {
  const of = q => sizeEngine(validateEngine(specFromRequest(q)));
  assert(of('a v8 engine').cylinders === 8, 'a v8 is not eight cylinders');
  assert(of('a v8 engine').layout === 'vee', 'a v8 is not a V');
  assert(of('an inline six engine').cylinders === 6, 'an inline six is not six cylinders');
  assert(of('a boxer four engine').layout === 'flat', 'a boxer is not flat');
  assert(of('a radial engine').layout === 'radial', 'a radial is not radial');
  assert(of('a radial engine').cylinders % 2 === 1, 'a single-row radial came out even');
  assert(of('a turbofan engine').kind === 'turbofan', 'a turbofan is not a turbofan');
  assert(of('a brushless outrunner motor').kind === 'emotor', 'a brushless motor is not a motor');
  assert(of('a 2jz engine').cylinders === 6, 'the catalogue did not answer for a 2JZ');
  near(of('a 5 litre v8 engine').litres, 5, 0.2, 'a stated capacity was ignored');
});

check('the request matcher does not grab things that are not engines', () => {
  for (const q of ['a wooden stool', 'a desk lamp with a folding arm', 'a cardboard box']) {
    assert(!ENGINE_RE.test(q), `"${q}" was taken for an engine`);
    assert(!engineBlock(q), `"${q}" got the engine prompt block`);
  }
  assert(ENGINE_RE.test('a v8 engine') && engineBlock('a v8 engine'), 'an engine request got no engine block');
});

check('the spec the plan carries is clamped like everything else', () => {
  assert(validateEngine(null) === null, 'null became an engine');
  assert(validateEngine({ kind: 'sandwich' }) === null, 'a sandwich became an engine');
  const e = validateEngine({ kind: 'ice', bore: -5, stroke: 1e6, cylinders: 99, redline: 1e9 });
  assert(e.bore > 0 && e.stroke <= 400 && e.cylinders <= 16 && e.redline <= 20000, 'nothing was clamped');
  const t = validateEngine({ kind: 'turbofan', bypassRatio: 900, fanDiameter: -3 });
  assert(t.bypassRatio <= 15 && t.fanDiameter > 0, 'the turbofan spec was not clamped');
});

/* ------------------------------------------------------------------ */
/* through the whole pipeline                                          */
/* ------------------------------------------------------------------ */
check('offline, with no engine reachable, the shop still builds a real V8', () => {
  const plan = validatePlan(offlinePlan('a v8 engine', null), 'a v8 engine');
  assert(plan.engine?.kind === 'ice', 'the offline build carries no engine spec');
  const parts = planParts(plan);
  const roles = parts.filter(p => p.engine_role).map(p => p.engine_role);
  for (const need of ['block', 'crank', 'cylinder', 'head']) {
    assert(roles.includes(need), `an offline V8 has no ${need}`);
  }
  assert(!faultsOf(analyseEngine(plan)).length, 'the offline V8 has faults in it');
  near(sizeEngine(plan.engine).cylinders, 8, 0, 'the offline V8 is not a V8');
});

/* Recall scores on keyword overlap and "engine" is a keyword on anything
   with a motor in it, so a rover in the library used to answer a turbofan
   request with three boxes — and it looked exactly like a build, which is
   why this is a test and not a comment. */
check('a recalled recipe cannot answer an engine request with something else', () => {
  const rover = {
    skill: {
      name: 'four-wheeled rover', class: 'vehicle', confidence: 0.88,
      recipe: { parts: [
        { name: 'chassis', shape: 'box', material: 'metal', size: [0.6, 0.1, 0.4] },
        { name: 'mast', shape: 'rod', material: 'metal', size: [0.06, 0.5, 0.06], attach: { to: 0, face: 'top' } },
        { name: 'dish', shape: 'cone', material: 'plastic', size: [0.2, 0.15, 0.2], attach: { to: 1, face: 'top' } }
      ] }
    }
  };
  const hijacked = validatePlan(offlinePlan('a turbofan engine', rover), 'a turbofan engine');
  const roles = planParts(hijacked).filter(p => p.engine_role).map(p => p.engine_role);
  for (const need of ['fan', 'combustor', 'hpt', 'nozzle']) {
    assert(roles.includes(need), `the recalled rover ate the turbofan — no ${need}`);
  }
  assert(hijacked.engine?.kind === 'turbofan', 'the arithmetic did not win');

  /* And the other way round: a recipe that really does hold engine parts is
     still the better answer, because that is a build somebody checked. */
  const learnedV8 = {
    skill: {
      name: 'small block', class: 'engine', confidence: 0.9,
      recipe: { parts: planParts(validatePlan(offlinePlan('a v8 engine', null), 'a v8 engine')) }
    }
  };
  const kept = validatePlan(offlinePlan('a v8 engine', learnedV8), 'a v8 engine');
  assert(planParts(kept).some(p => p.engine_role === 'crank'), 'a real engine recipe was thrown away');

  /* And a request with no engine in it is untouched by any of this. */
  const rover2 = validatePlan(offlinePlan('a four-wheeled rover', rover), 'a four-wheeled rover');
  assert(planParts(rover2).length === 3, 'the recall path stopped working for everything else');
});

/* Both of these were found by building all three families headless and
   reading the findings rather than the picture, and neither of them threw:
   the motor stood there with its shaft alongside it, and the optimiser
   offered to scrap the stator. */
check('nothing that belongs inside an engine gets shoved out of it', () => {
  for (const q of ['a brushless outrunner motor', 'a turbofan engine', 'a v8 engine']) {
    const plan = validatePlan(offlinePlan(q, null), q);
    const solved = inspectPlan(plan).solved;
    assert(solved.stable !== false, `the ${q} falls over`);

    /* A part attached `inside` has to still be inside something. The shaft
       used to end up beside the motor, which reads as a build and is not. */
    const parts = planParts(plan);
    parts.forEach((p, i) => {
      if (p.attach?.face !== 'inside') return;
      /* Both sides may be arrayed — a piston per cylinder — so instance n
         of one is checked against instance n of the other, which is the
         same pairing the firing order relies on. */
      const mine = solved.instances.filter(x => x.src === i);
      const hosts = solved.instances.filter(x => x.src === p.attach.to);
      if (!mine.length || !hosts.length) return;
      mine.forEach((me, n) => {
        const host = hosts[Math.min(n, hosts.length - 1)];
        for (let ax = 0; ax < 3; ax++) {
          const gap = Math.abs(me.pos[ax] - host.pos[ax]) - (me.half[ax] + host.half[ax]);
          assert(gap < 0, `the ${p.name} sits outside the ${parts[p.attach.to]?.name} on axis ${ax}`);
        }
      });
    });

    /* And the optimiser must not offer to scrap any of them. */
    const buried = analyse(plan, solved).filter(f => f.id.startsWith('buried-'));
    assert(!buried.length, `the optimiser wants to scrap ${buried.map(f => f.title).join(', ')}`);
  }
});

/* A head that has come adrift does not throw and does not fail any sum —
   the V8 rendered with both heads crossed in the sky above the block and
   every number about it was still right. So: a head caps its own bank. */
check('every cylinder head sits on the bores it closes', () => {
  for (const q of ['a v8 engine', 'a 2JZ inline six']) {
    const plan = validatePlan(offlinePlan(q, null), q);
    const parts = planParts(plan);
    const solved = inspectPlan(plan).solved;
    const at = i => solved.instances.filter(x => x.src === i);

    parts.forEach((p, i) => {
      if (p.engine_role !== 'head') return;
      const head = at(i)[0];
      const bores = parts
        .map((q2, j) => ({ q2, j }))
        .filter(({ q2 }) => q2.engine_role === 'cylinder')
        .flatMap(({ j }) => at(j));
      assert(bores.length, `${q}: no bores at all`);

      /* the nearest bore has to be under it, touching it, and inside it */
      const near = bores.reduce((a, b) =>
        Math.hypot(b.pos[0] - head.pos[0], b.pos[2] - head.pos[2])
        < Math.hypot(a.pos[0] - head.pos[0], a.pos[2] - head.pos[2]) ? b : a);
      const gapY = (head.pos[1] - head.half[1]) - (near.pos[1] + near.half[1]);
      assert(gapY < near.half[1], `${q}: the ${p.name} floats ${gapY.toFixed(3)}m above its bores`);
      assert(Math.abs(head.pos[2] - near.pos[2]) < head.half[2] + near.half[2],
        `${q}: the ${p.name} is not over its own bank`);
      assert(Math.abs(head.pos[0] - near.pos[0]) < head.half[0],
        `${q}: the ${p.name} has slid off the end of the engine`);
    });
  }
});

check('a piston part is made in the machine shop by the trade that owns it', () => {
  const plan = validatePlan(offlinePlan('a v8 engine', null), 'a v8 engine');
  const steps = plan.steps.filter(s => s.part?.engine_role);
  assert(steps.length, 'no engine parts reached the floor');
  for (const s of steps) {
    assert(s.room === 'machining', `a ${s.part.engine_role} is being made in the ${s.room} bay`);
  }
  assert(roleForMaterial('alloy') === 'powerplant', 'alloy does not belong to the powerplant trade');
  assert(roleById('powerplant').station === 'machining', 'the engineer does not work in the machine shop');
});

/* ------------------------------------------------------------------ */
/* the floor                                                           */
/* ------------------------------------------------------------------ */
const runFloor = async request => {
  const fallbackParts = planParts(validatePlan(offlinePlan(request, null), request));
  const floor = new ShopFloor({ ask: async () => ({ ok: false }), log: () => {} });
  const { plan } = await floor.run(request, { fallbackParts, offline: true });
  return validatePlan(plan, request);
};

const asyncChecks = [];
const acheck = (name, fn) => asyncChecks.push([name, fn]);

acheck('an engine survives being split across the trades and merged back', async () => {
  const plan = await runFloor('a v8 engine');
  const roles = planParts(plan).filter(p => p.engine_role).map(p => p.engine_role);
  for (const need of ['block', 'crank', 'cylinder', 'head', 'flywheel']) {
    assert(roles.includes(need), `the merge lost the ${need}`);
  }
  assert(plan.engine?.kind === 'ice', 'the merged plan carries no engine spec');
  assert(!faultsOf(analyseEngine(plan)).length,
    `the merged V8 has faults: ${faultsOf(analyseEngine(plan)).map(f => f.title)}`);
  // and every attachment still points backwards after the renumbering
  planParts(plan).forEach((p, i) => {
    if (p.attach) assert(p.attach.to < i, `${p.name} is bolted forwards after the merge`);
  });
});

acheck('the engine work lands on the engineer, not on structures', async () => {
  const plan = await runFloor('a v8 engine');
  const mine = plan.steps.filter(s => s.part?.engine_role);
  for (const s of mine) assert(s.by === 'powerplant', `a ${s.part.engine_role} was given to ${s.by}`);
  assert(mine.length >= 6, `only ${mine.length} engine parts reached the floor`);
});

acheck('all three families go through the floor end to end', async () => {
  for (const [request, kind] of [['a turbofan engine', 'turbofan'], ['a brushless outrunner motor', 'emotor']]) {
    const plan = await runFloor(request);
    assert(plan.engine?.kind === kind, `${request} did not come out as a ${kind}`);
    assert(planParts(plan).filter(p => p.engine_role).length >= 4, `${request} lost most of its parts`);
    assert(!faultsOf(analyseEngine(plan)).length, `${request} came out with faults`);
    assert(describeEngine(plan).length > 20, `${request} could not be described`);
  }
});

/* ------------------------------------------------------------------ */
(async () => {
  for (const [name, fn] of asyncChecks) {
    try { await fn(); pass++; out.push(`  ok    ${name}`); }
    catch (e) { fail++; out.push(`  FAIL  ${name}\n          ${e.message}`); }
  }
  console.log(out.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
