/* =====================================================================
   Engines.

   The third thing in this app that is not a tree. assembly.js solves a
   tree of attachments; circuit.js solves a graph of nets; an engine is a
   KINEMATIC CHAIN WITH A GOVERNING DIMENSION SET — nothing about it is a
   free choice. Give a piston engine a bore, a stroke, a rod length and a
   chamber volume and every other number falls out: displacement, the
   compression ratio, the deck height, how far apart the bores sit, how
   wide the block is at that bank angle, how fast the piston is moving at
   the redline and in what order the cylinders fire. Give a turbofan a mass
   flow, a bypass ratio and an overall pressure ratio and the annulus area
   at every station falls out of compressible flow, and the hub and tip
   diameters fall out of that.

   Which is the whole reason this file exists. The shop used to ask the
   model for "a crankshaft" and get a 0.5m cylinder with no relationship to
   anything around it — an engine-shaped stack. Here the numbers come
   first and the geometry is derived from them, exactly as a resistor's
   body comes from COMPONENTS rather than from whatever the model guessed.

   Where the numbers come from:
     · reciprocating architecture — the engine definitions in
       ange-yaghi/engine-sim (bore, stroke, rod, compression height,
       chamber volume, bank angle, journal angles, redline)
     · turbofan sizing — RohitNag11/JetEngineDesigner: annulus area from
       ṁ/(ρVx) with static density recovered from stagnation through the
       axial Mach number, hub and tip diameters from the mean radius and
       the annulus area, stage counts from a per-stage pressure ratio, and
       the validity list out of Engine.__check_validity
     · the catalogue is indexed maker → model, which is the one good idea
       in the carspecs API — a lookup, not a simulation

   Imports NOTHING. No three.js, no DOM, no fetch. Every number in here is
   checked in node in test/engine.test.mjs against engines that exist.

   UNITS: millimetres, degrees, rpm, kelvin, pascals, kg/s — the units the
   sources are written in. engineParts() is the ONLY place that crosses
   into the metres the solver works in, and it says so.
   ===================================================================== */

export const ENGINE_KINDS = ['ice', 'turbofan', 'emotor'];

/* Air, at sea level, on a standard day. The constants every one of these
   sums is built on (engine_design.py get_constants). */
export const GAS = {
  gamma: 1.4,          // ratio of specific heats
  R: 287,              // J/kg·K
  cp: 1005,            // J/kg·K
  T_sea: 288.15,       // K
  P_sea: 101300        // Pa
};

/* ------------------------------------------------------------------ */
/* the layouts                                                         */
/* ------------------------------------------------------------------ */
/* `banks` is how many rows of cylinders; `ring` means they are spoked
   around the crank rather than sitting in rows. A radial is the one
   layout where the cylinder count itself is constrained — a single-row
   radial must have an odd number or the four-stroke cycle cannot come
   round evenly. */
export const LAYOUTS = {
  single: { banks: 1, angle: 0,   ring: false, label: 'single' },
  inline: { banks: 1, angle: 0,   ring: false, label: 'inline' },
  vee:    { banks: 2, angle: 90,  ring: false, label: 'V' },
  flat:   { banks: 2, angle: 180, ring: false, label: 'flat' },
  radial: { banks: 1, angle: 0,   ring: true,  label: 'radial' }
};

export const LAYOUT_IDS = Object.keys(LAYOUTS);

/* Firing orders that are not derivable — these are what the engines
   actually use, and a made-up order on a real engine is worse than no
   order at all. Keyed layout + cylinder count. Anything not in here is
   generated even-fire. */
const FIRING_ORDERS = {
  'single-1':  [1],
  'inline-2':  [1, 2],
  'inline-3':  [1, 2, 3],
  'inline-4':  [1, 3, 4, 2],
  'inline-5':  [1, 2, 4, 5, 3],
  'inline-6':  [1, 5, 3, 6, 2, 4],
  'flat-4':    [1, 3, 2, 4],
  'flat-6':    [1, 4, 5, 2, 3, 6],
  'vee-6':     [1, 4, 2, 5, 3, 6],
  'vee-8':     [1, 8, 7, 2, 6, 5, 4, 3],       // GM LS
  'vee-10':    [1, 10, 9, 4, 3, 6, 5, 8, 7, 2],
  'vee-12':    [1, 12, 5, 8, 3, 10, 6, 7, 2, 11, 4, 9],
  'radial-5':  [1, 3, 5, 2, 4],
  'radial-7':  [1, 3, 5, 7, 2, 4, 6],
  'radial-9':  [1, 3, 5, 7, 9, 2, 4, 6, 8]
};

/* ------------------------------------------------------------------ */
/* the catalogue — maker → model → engine                              */
/* ------------------------------------------------------------------ */
/* Every one of these is a real engine and every number is off its own
   definition file in engine-sim, converted to millimetres. They are the
   starting point when somebody asks for "a v8" and the fixtures the sums
   are checked against — a displacement that comes out wrong here is
   wrong against an engine anybody can look up. */
const IN = 25.4;   // one inch, in mm

export const ICE_REFERENCES = {
  honda_trx520: {
    maker: 'Honda', model: 'TRX520', kind: 'ice', layout: 'single', cylinders: 1,
    bore: 92, stroke: 78, rod: 4.705 * IN, compressionHeight: IN, compressionRatio: 9.5,
    vAngle: 0, redline: 5000, fuel: 'petrol',
    note: 'a single-cylinder utility engine — one of everything'
  },
  hayabusa: {
    maker: 'Suzuki', model: 'Hayabusa', kind: 'ice', layout: 'inline', cylinders: 4,
    bore: 81, stroke: 65, rod: 4.705 * IN, compressionHeight: IN, compressionRatio: 11,
    vAngle: 0, redline: 11000, fuel: 'petrol',
    note: 'a very oversquare motorcycle four — short stroke, high revs'
  },
  toyota_2jz: {
    maker: 'Toyota', model: '2JZ', kind: 'ice', layout: 'inline', cylinders: 6,
    bore: 86, stroke: 86, rod: 142, compressionHeight: 32.8, compressionRatio: 10.5,
    vAngle: 0, redline: 6000, fuel: 'petrol',
    note: 'square inline six — bore and stroke the same to the millimetre'
  },
  gm_ls: {
    maker: 'GM', model: 'LS', kind: 'ice', layout: 'vee', cylinders: 8,
    bore: 3.78 * IN, stroke: 3.622 * IN, rod: 160, compressionHeight: IN, compressionRatio: 9.5,
    vAngle: 90, redline: 6500, fuel: 'petrol',
    journals: [0, 270, 90, 180],
    note: 'the pushrod V8 — 90 degrees, four rod journals, two cylinders on each'
  },
  ferrari_f136: {
    maker: 'Ferrari', model: 'F136', kind: 'ice', layout: 'vee', cylinders: 8,
    bore: 94, stroke: 81, rod: 160, compressionHeight: IN, compressionRatio: 11.3,
    vAngle: 90, redline: 9000, fuel: 'petrol',
    note: 'a flat-plane-ish race V8 — oversquare and revs to nine'
  },
  subaru_ej25: {
    maker: 'Subaru', model: 'EJ25', kind: 'ice', layout: 'flat', cylinders: 4,
    bore: 99.5, stroke: 79, rod: 131.5, compressionHeight: 30, compressionRatio: 10,
    vAngle: 180, redline: 7000, fuel: 'petrol',
    note: 'a boxer four — two banks lying flat, so the engine is wide and low'
  },
  merlin_v12: {
    maker: 'Rolls-Royce', model: 'Merlin V-1650', kind: 'ice', layout: 'vee', cylinders: 12,
    bore: 5.4 * IN, stroke: 6 * IN, rod: 14 * IN, compressionHeight: IN, compressionRatio: 6,
    vAngle: 60, redline: 3000, fuel: 'petrol', induction: 'supercharged',
    note: 'a 27 litre aero V12 — long stroke, slow turning, enormous'
  },
  radial_9: {
    maker: 'Generic', model: 'Radial 9', kind: 'ice', layout: 'radial', cylinders: 9,
    bore: 5 * IN, stroke: 5.5 * IN, rod: 16 * IN, compressionHeight: IN, compressionRatio: 6,
    vAngle: 0, redline: 3000, fuel: 'petrol', induction: 'supercharged',
    note: 'nine cylinders round the crank — odd count, or it cannot fire evenly'
  }
};

/* The turbofan the sizing was written against — a 2-spool high-bypass
   engine, the constants straight off engine_design.py. The station
   pressures and temperatures are the cycle; everything geometric is
   derived from them. */
export const TURBOFAN_REFERENCE = {
  maker: 'Generic', model: 'High-bypass turbofan', kind: 'turbofan',
  massFlow: 20.5,                // kg/s THROUGH THE CORE
  bypassRatio: 7,
  overallPressureRatio: 40,
  fanDiameter: 2600,             // mm — engine_diameter 2.6m
  fanHubTipRatio: 0.35,
  fanTipMach: 1.3,
  innerFanPR: 1.8,
  outerFanPR: 2.5,
  lpcPR: 2.5,
  perStagePR: 1.3,
  compAxialVelocity: 190,        // m/s
  turbineAxialVelocity: 150,     // m/s
  minBladeLength: 12,            // mm
  lptMinBladeLength: 31,         // mm
  turbineEfficiency: 0.92,
  /* the cycle, station by station (P in Pa, T in K) */
  P_021: 91802 / 1.0, T_021: 260.73,
  P_025: 91802,   T_025: 331.86,
  P_03: 1468830,  T_03: 758.17,
  P_041: 1424765, T_041: 1677.70,
  P_044: 410468,  T_044: 1268.72,
  P_045: 402258,  T_045: 1268.72,
  P_05: 82688,    T_05: 892.91,
  note: 'two spools: fan and LPC and LPT on one shaft, HPC and HPT on the other'
};

/* No source repo carries motor design, so these are hand-written from
   ordinary practice rather than lifted, and it matters that the
   difference is visible. Dimensions in mm, Kv in rpm/volt. */
export const EMOTOR_REFERENCES = {
  outrunner_2814: {
    maker: 'Generic', model: '2814 outrunner', kind: 'emotor', form: 'outrunner',
    statorOD: 28, statorID: 10, stackLength: 14, slots: 12, poles: 14,
    magnetThickness: 2.5, airgap: 0.5, kv: 700, voltage: 14.8,
    note: 'a model-aircraft outrunner — the magnets are on the outside and spin'
  },
  inrunner_540: {
    maker: 'Generic', model: '540 inrunner', kind: 'emotor', form: 'inrunner',
    statorOD: 36, statorID: 14, stackLength: 50, slots: 12, poles: 4,
    magnetThickness: 3, airgap: 0.4, kv: 3000, voltage: 7.4,
    note: 'a can motor — the rotor is inside and the case does not turn'
  },
  industrial_bldc: {
    maker: 'Generic', model: 'Industrial BLDC', kind: 'emotor', form: 'inrunner',
    statorOD: 110, statorID: 60, stackLength: 90, slots: 27, poles: 30,
    magnetThickness: 5, airgap: 0.8, kv: 26, voltage: 400,
    note: 'a servo-class motor — many poles, low Kv, high torque'
  }
};

/* Flat index, maker → model → engine, so a request can be looked up the
   way somebody would actually ask for it. */
export const CATALOGUE = { ...ICE_REFERENCES, ...EMOTOR_REFERENCES, turbofan: TURBOFAN_REFERENCE };
export const CATALOGUE_IDS = Object.keys(CATALOGUE);

/* ------------------------------------------------------------------ */
/* small arithmetic                                                    */
/* ------------------------------------------------------------------ */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const round = (v, p = 2) => Math.round(v * 10 ** p) / 10 ** p;
const gcd = (a, b) => (b ? gcd(b, a % b) : Math.abs(a));
const lcm = (a, b) => Math.abs(a * b) / (gcd(a, b) || 1);

/* ------------------------------------------------------------------ */
/* compressible flow — the four sums the turbofan sizing rests on      */
/* ------------------------------------------------------------------ */
/* Stagnation density from the stagnation state. */
export const stagDensity = (P0, T0) => P0 / (GAS.R * T0);

/* Static temperature, having given up V²/2cp of the stagnation enthalpy
   to the axial velocity. */
export const staticTemp = (T0, V) => T0 - (V * V) / (2 * GAS.cp);

/* Mach number of an axial velocity in air at that static temperature. */
export const machOf = (V, T) => V / Math.sqrt(GAS.gamma * GAS.R * Math.max(1, T));

/* Static density from stagnation density and Mach — isentropic. */
export const staticDensity = (rho0, M) =>
  rho0 * (1 + ((GAS.gamma - 1) / 2) * M * M) ** (-1 / (GAS.gamma - 1));

/* The one that does the work: how much annulus a mass flow needs. */
export function annulusArea(massFlow, P0, T0, axialVelocity) {
  const T = staticTemp(T0, axialVelocity);
  const M = machOf(axialVelocity, T);
  const rho = staticDensity(stagDensity(P0, T0), M);
  return massFlow / (rho * axialVelocity);      // m²
}

/* utils/geometry.py, verbatim in intent: an annulus of area A whose mean
   radius is r has these hub and tip diameters. */
export const hubDiameterFromMean = (meanRadius, area) =>
  (4 * Math.PI * meanRadius ** 2 - area) / (2 * Math.PI * meanRadius);
export const tipDiameterFromMean = (meanRadius, area) =>
  (4 * Math.PI * meanRadius ** 2 + area) / (2 * Math.PI * meanRadius);
export const meanRadiusFromBlade = (bladeLength, area) => area / (2 * Math.PI * bladeLength);

/* ------------------------------------------------------------------ */
/* the slider-crank — where the piston is at a given crank angle       */
/* ------------------------------------------------------------------ */
/* Distance from the crank centreline to the gudgeon pin. The exact
   equation, not a sine approximation: the second term is what makes a
   piston's travel asymmetric between the two half-turns, and it is the
   whole reason a short rod is hard on an engine. */
export function pistonAt(theta, throwR, rod) {
  const r = num(throwR), l = num(rod, 1);
  const s = r * Math.sin(theta);
  return r * Math.cos(theta) + Math.sqrt(Math.max(0, l * l - s * s));
}

/* ------------------------------------------------------------------ */
/* firing                                                              */
/* ------------------------------------------------------------------ */
/* A four-stroke fires every cylinder once per two turns, so an even-fire
   engine has 720/N degrees between bangs. */
export function firingOrder(layout, cylinders) {
  const n = Math.max(1, Math.round(num(cylinders, 1)));
  const key = `${layout}-${n}`;
  if (FIRING_ORDERS[key]) return FIRING_ORDERS[key].slice();
  /* Nothing known for this combination: fire them in order. It is a
     legitimate even-fire answer, it is just not the one the factory
     picked, and pretending otherwise would be worse. */
  return Array.from({ length: n }, (_, i) => i + 1);
}

/* The crank angle each cylinder fires at, in the order they fire. */
export function firingAngles(layout, cylinders) {
  const order = firingOrder(layout, cylinders);
  const interval = 720 / order.length;
  const at = new Array(order.length);
  order.forEach((cyl, i) => { at[cyl - 1] = round(i * interval, 1); });
  return at;
}

/* ------------------------------------------------------------------ */
/* sizing a piston engine                                              */
/* ------------------------------------------------------------------ */
/* Bore spacing on a production block runs about 1.2 times the bore —
   enough iron between the bores for a head gasket to seal against. Under
   1.0 the bores intersect, which is a fault rather than a tight design. */
const BORE_SPACING = 1.22;

export function sizeICE(spec = {}) {
  const layoutId = LAYOUTS[spec.layout] ? spec.layout : 'inline';
  const L = LAYOUTS[layoutId];
  const cylinders = Math.max(1, Math.round(num(spec.cylinders, 4)));
  const bore = Math.max(1, num(spec.bore, 86));
  const stroke = Math.max(1, num(spec.stroke, 86));
  const rod = Math.max(1, num(spec.rod, stroke * 1.7));
  const compressionHeight = Math.max(0, num(spec.compressionHeight, 30));
  const vAngle = L.banks > 1 ? clamp(num(spec.vAngle, L.angle), 0, 180) : 0;
  const redline = Math.max(100, num(spec.redline, 6000));
  const fuel = spec.fuel === 'diesel' ? 'diesel' : 'petrol';
  /* Whether anything is pushing air into it. It is not a detail: a blown
     engine runs a DELIBERATELY low compression ratio so the boost has
     somewhere to go, which is why a Merlin is 6:1 and a road car is 10.
     Judge one against the other's band and you fail every aero engine
     ever built. */
  const induction = ['supercharged', 'turbocharged'].includes(spec.induction) ? spec.induction : 'na';

  /* the cylinder */
  const sweptPerCyl = (Math.PI / 4) * bore * bore * stroke / 1000;  // mm³ → cc
  const displacement = sweptPerCyl * cylinders;                     // cc

  /* Chamber volume and compression ratio are the same fact stated two
     ways, and only one of them can be the input. A catalogue entry gives
     the ratio, because that is the number an engine is quoted by and the
     one anybody can check; a spec off the bench gives the chamber,
     because that is the dimension somebody edits. Whichever arrives, the
     other is derived from it — storing both and letting them drift is how
     you end up reporting a compression ratio the engine does not have. */
  const chamber = Number.isFinite(Number(spec.chamber))
    ? Math.max(0.1, Number(spec.chamber))
    : Math.max(0.1, sweptPerCyl / (clamp(num(spec.compressionRatio, 10), 1.5, 30) - 1));
  const compressionRatio = (sweptPerCyl + chamber) / chamber;

  /* the rotating assembly */
  const crankThrow = stroke / 2;
  const deckHeight = crankThrow + rod + compressionHeight;
  const rodStrokeRatio = rod / stroke;
  const boreStrokeRatio = bore / stroke;
  const meanPistonSpeed = (2 * stroke / 1000) * redline / 60;       // m/s

  /* the block */
  const banks = L.banks;
  const perBank = Math.ceil(cylinders / banks);
  const boreSpacing = bore * BORE_SPACING;
  const halfAngle = (vAngle / 2) * Math.PI / 180;

  let blockLength, blockWidth, blockHeight, crankRadius = 0;
  if (L.ring) {
    /* a radial: the cylinders are spokes, so the "block" is the crankcase
       in the middle and the engine's size is the circle they sweep */
    crankRadius = (bore * cylinders) / (2 * Math.PI) + bore * 0.6;
    blockLength = bore * 1.4;                                       // it is SHORT
    blockWidth = 2 * (crankRadius + deckHeight);
    blockHeight = blockWidth;
  } else {
    blockLength = boreSpacing * perBank + bore * 0.5;
    blockWidth = banks > 1
      ? 2 * Math.sin(halfAngle) * deckHeight + bore * 1.1
      : bore * 1.6;
    blockHeight = banks > 1
      ? Math.cos(halfAngle) * deckHeight + bore * 0.7
      : deckHeight + bore * 0.7;
  }

  const order = firingOrder(layoutId, cylinders);
  const journals = Array.isArray(spec.journals) && spec.journals.length
    ? spec.journals.map(v => clamp(num(v), 0, 360))
    : firingAngles(layoutId, cylinders).map(a => round(a / 2, 1));   // crank turns half as often

  return {
    kind: 'ice',
    name: spec.name || [spec.maker, spec.model].filter(Boolean).join(' ') || 'piston engine',
    layout: layoutId, layoutLabel: L.label, cylinders, banks, perBank, vAngle, fuel, redline, induction,
    bore: round(bore), stroke: round(stroke), rod: round(rod),
    compressionHeight: round(compressionHeight), chamber: round(chamber),
    sweptPerCyl: round(sweptPerCyl), displacement: round(displacement),
    litres: round(displacement / 1000, 2),
    compressionRatio: round(compressionRatio),
    crankThrow: round(crankThrow), deckHeight: round(deckHeight), boreSpacing: round(boreSpacing),
    rodStrokeRatio: round(rodStrokeRatio), boreStrokeRatio: round(boreStrokeRatio),
    meanPistonSpeed: round(meanPistonSpeed),
    blockLength: round(blockLength), blockWidth: round(blockWidth), blockHeight: round(blockHeight),
    crankRadius: round(crankRadius),
    firingOrder: order, firingAngles: firingAngles(layoutId, cylinders), journals
  };
}

/* ------------------------------------------------------------------ */
/* sizing a turbofan                                                   */
/* ------------------------------------------------------------------ */
/* A compressor needs as many stages as it takes to multiply up to its
   pressure ratio at the ratio one stage can manage. */
const stagesFor = (pressureRatio, perStage) =>
  Math.max(1, Math.ceil(Math.log(Math.max(1.001, pressureRatio)) / Math.log(Math.max(1.01, perStage))));

export function sizeTurbofan(spec = {}) {
  const s = { ...TURBOFAN_REFERENCE, ...spec };
  const massFlow = Math.max(0.5, num(s.massFlow, 20.5));              // core, kg/s
  const bypassRatio = clamp(num(s.bypassRatio, 7), 0, 15);
  const opr = clamp(num(s.overallPressureRatio, 40), 2, 70);
  const fanDiameter = Math.max(100, num(s.fanDiameter, 2600));        // mm
  const hubTip = clamp(num(s.fanHubTipRatio, 0.35), 0.1, 0.8);
  const tipMach = clamp(num(s.fanTipMach, 1.3), 0.4, 2);
  const lpcPR = clamp(num(s.lpcPR, 2.5), 1.05, 10);
  const innerFanPR = clamp(num(s.innerFanPR, 1.8), 1.01, 4);
  const perStagePR = clamp(num(s.perStagePR, 1.3), 1.05, 2);
  const Vc = clamp(num(s.compAxialVelocity, 190), 50, 350);
  const Vt = clamp(num(s.turbineAxialVelocity, 150), 50, 350);

  const totalMassFlow = massFlow * (1 + bypassRatio);
  const bypassMassFlow = totalMassFlow - massFlow;

  /* the fan. Tip speed comes from the tip Mach number in ambient air, and
     the shaft speed from the tip speed — that is what sets the low spool. */
  const tipSpeed = tipMach * Math.sqrt(GAS.gamma * GAS.R * GAS.T_sea);   // m/s
  const fanRadius = fanDiameter / 2000;                                  // m
  const fanHubRadius = fanRadius * hubTip;
  const angularVelocity = tipSpeed / fanRadius;                          // rad/s
  const fanRpm = angularVelocity * 60 / (2 * Math.PI);
  const fanArea = Math.PI * (fanRadius ** 2 - fanHubRadius ** 2);
  const innerFanMeanRadius = (fanRadius * hubTip + fanRadius) / 2 * 0.6; // the core-side half of the fan

  /* every axial station: how much annulus the flow needs, and what hub
     and tip that annulus implies about the mean radius chosen for it */
  const station = (id, label, P0, T0, V, meanRadius, extra = {}) => {
    const area = annulusArea(massFlow, P0, T0, V);
    const bladeLength = area / (2 * Math.PI * meanRadius);
    return {
      id, label,
      area: round(area, 4),
      meanRadius: round(meanRadius * 1000),                     // mm
      hubDiameter: round(hubDiameterFromMean(meanRadius, area) * 1000),
      tipDiameter: round(tipDiameterFromMean(meanRadius, area) * 1000),
      bladeLength: round(bladeLength * 1000),
      T0: round(T0, 1), P0: round(P0), ...extra
    };
  };

  const lpcMean = innerFanMeanRadius;
  const hpcMean = innerFanMeanRadius * 0.72;
  const hptMean = hpcMean * 1.05;
  const lptMean = hptMean * 1.35;

  const lpcPRactual = lpcPR / innerFanPR;
  const hpcPR = opr / lpcPR;
  const hptPR = num(s.P_044) / num(s.P_041, 1);
  const lptPR = num(s.P_05) / num(s.P_045, 1);

  const stations = [
    station('lpc', 'low-pressure compressor', num(s.P_025), num(s.T_025), Vc, lpcMean,
      { stages: stagesFor(lpcPRactual, perStagePR), pressureRatio: round(lpcPRactual) }),
    station('hpc', 'high-pressure compressor', num(s.P_03), num(s.T_03), Vc, hpcMean,
      { stages: stagesFor(hpcPR, perStagePR), pressureRatio: round(hpcPR) }),
    station('hpt', 'high-pressure turbine', num(s.P_044), num(s.T_044), Vt, hptMean,
      { stages: 2, pressureRatio: round(hptPR, 3) }),
    station('lpt', 'low-pressure turbine', num(s.P_05), num(s.T_05), Vt, lptMean,
      { stages: 4, pressureRatio: round(lptPR, 3) })
  ];

  /* ideal nozzles, both streams, expanded to ambient. Not a performance
     deck — an order-of-magnitude thrust so the bench can say what class
     of engine this is. */
  const jet = (T0, P0) => Math.sqrt(Math.max(0,
    2 * GAS.cp * T0 * (1 - (GAS.P_sea / Math.max(GAS.P_sea, P0)) ** ((GAS.gamma - 1) / GAS.gamma))));
  const coreJet = jet(num(s.T_05, 892.91), num(s.P_05, 82688));
  const fanJet = jet(GAS.T_sea * innerFanPR ** ((GAS.gamma - 1) / GAS.gamma), GAS.P_sea * num(s.outerFanPR, 2.5));
  const thrust = (massFlow * coreJet + bypassMassFlow * fanJet) / 1000;   // kN

  /* Does the cycle close? A spool takes exactly as much work out of the
     gas as its compressor puts in, and what is left over turns the fan.
     Comparing pressure ratios across the two halves is the obvious check
     and it is the wrong one — the overall pressure ratio is measured from
     ambient and includes the ram and the fan, while the turbines only
     ever see what is left after the combustor's losses. Work is the thing
     that has to balance, so work is what is checked. Per kg/s of core. */
  const dT = (a, b) => Math.max(0, num(a) - num(b));
  const compressorWork = GAS.cp * (dT(s.T_025, s.T_021) + dT(s.T_03, s.T_025)) / 1000;   // kJ/kg
  const turbineWork = GAS.cp * (dT(s.T_041, s.T_044) + dT(s.T_045, s.T_05)) / 1000;
  const fanWork = turbineWork - compressorWork;                    // what is left for the fan
  const fanWorkPerBypassKg = bypassMassFlow > 0 ? (fanWork * massFlow) / bypassMassFlow : 0;
  /* and the fan pressure ratio that surplus actually buys */
  const impliedFanPR = (1 + (fanWorkPerBypassKg * 1000) / (GAS.cp * GAS.T_sea)) ** (GAS.gamma / (GAS.gamma - 1));

  const coreDiameter = Math.max(...stations.map(st => st.tipDiameter));
  const coreLength = fanDiameter * 1.6;
  const overallLength = fanDiameter * 2.2;

  return {
    kind: 'turbofan',
    name: spec.name || [s.maker, s.model].filter(Boolean).join(' ') || 'turbofan',
    massFlow: round(massFlow, 2), totalMassFlow: round(totalMassFlow, 1),
    bypassMassFlow: round(bypassMassFlow, 1),
    bypassRatio: round(bypassRatio, 2), overallPressureRatio: round(opr, 1),
    fanDiameter: round(fanDiameter), fanHubDiameter: round(fanDiameter * hubTip),
    fanHubTipRatio: round(hubTip, 3), fanTipMach: round(tipMach, 2),
    tipSpeed: round(tipSpeed), angularVelocity: round(angularVelocity),
    fanRpm: round(fanRpm), fanArea: round(fanArea, 3),
    innerFanMeanRadius: round(innerFanMeanRadius * 1000),
    spools: 2, stations,
    stages: stations.reduce((n, st) => n + st.stages, 0),
    compressorWork: round(compressorWork, 1), turbineWork: round(turbineWork, 1),
    fanWork: round(fanWork, 1), impliedFanPR: round(impliedFanPR, 2),
    turbineExpansion: round(1 / Math.max(1e-6, hptPR * lptPR), 2),
    combustorLength: round(fanDiameter * 0.22),
    nozzleDiameter: round(coreDiameter * 0.9),
    coreDiameter: round(coreDiameter), coreLength: round(coreLength),
    overallLength: round(overallLength),
    thrust: round(thrust, 1),
    fanBlades: Math.max(12, Math.round(fanDiameter / 110))
  };
}

/* ------------------------------------------------------------------ */
/* sizing an electric motor                                            */
/* ------------------------------------------------------------------ */
/* HAND-WRITTEN, unlike the two above — none of the source repos covers
   electric machines, so this is ordinary practice rather than lifted
   design code, and it should be read that way. */
export function sizeMotor(spec = {}) {
  const form = spec.form === 'outrunner' ? 'outrunner' : 'inrunner';
  const statorOD = Math.max(4, num(spec.statorOD, 28));
  const statorID = clamp(num(spec.statorID, statorOD * 0.36), 1, statorOD - 2);
  const stackLength = Math.max(2, num(spec.stackLength, 14));
  const slots = Math.max(3, Math.round(num(spec.slots, 12)));
  const poles = Math.max(2, Math.round(num(spec.poles, 14)));
  const magnetThickness = Math.max(0.4, num(spec.magnetThickness, 2.5));
  const airgap = clamp(num(spec.airgap, 0.5), 0.05, 3);
  const kv = Math.max(1, num(spec.kv, 700));
  const voltage = Math.max(0.5, num(spec.voltage, 14.8));

  /* On an outrunner the magnets ride outside the stator and the whole can
     turns; on an inrunner they are inside it. That one difference decides
     every diameter. */
  const rotorOD = form === 'outrunner'
    ? statorOD + 2 * (airgap + magnetThickness + 1.2)
    : statorID - 2 * airgap;
  const rotorID = form === 'outrunner' ? statorOD + 2 * airgap : rotorOD - 2 * magnetThickness;
  const overallDiameter = form === 'outrunner' ? rotorOD : statorOD + 3;

  /* Cogging: the torque ripple comes round once per LCM of slots and
     poles per revolution, so a HIGH lcm is a smooth motor. 12/14 gives 84
     and is why that combination is everywhere; 12/4 gives 12 and notches. */
  const coggingSteps = lcm(slots, poles);
  const noLoadRpm = kv * voltage;
  const torqueConstant = 9.5493 / kv;                              // Nm/A
  const rotorTipSpeed = Math.PI * (rotorOD / 1000) * noLoadRpm / 60;

  return {
    kind: 'emotor',
    name: spec.name || [spec.maker, spec.model].filter(Boolean).join(' ') || 'brushless motor',
    form, statorOD: round(statorOD), statorID: round(statorID), stackLength: round(stackLength),
    slots, poles, magnets: poles, magnetThickness: round(magnetThickness), airgap: round(airgap, 2),
    rotorOD: round(rotorOD), rotorID: round(rotorID), overallDiameter: round(overallDiameter),
    kv: round(kv), voltage: round(voltage, 1),
    noLoadRpm: Math.round(noLoadRpm), torqueConstant: round(torqueConstant, 4),
    coggingSteps, rotorTipSpeed: round(rotorTipSpeed, 1)
  };
}

export function sizeEngine(spec = {}) {
  const kind = ENGINE_KINDS.includes(spec?.kind) ? spec.kind : 'ice';
  if (kind === 'turbofan') return sizeTurbofan(spec);
  if (kind === 'emotor') return sizeMotor(spec);
  return sizeICE(spec);
}

/* ------------------------------------------------------------------ */
/* looking one up                                                      */
/* ------------------------------------------------------------------ */
const WORD_CYLINDERS = {
  single: 1, one: 1, twin: 2, two: 2, three: 3, triple: 3, four: 4, five: 5,
  six: 6, eight: 8, ten: 10, twelve: 12, sixteen: 16
};

export const ENGINE_RE =
  /\b(engine|turbofan|turbojet|turboprop|jet engine|motor|v-?\d{1,2}\b|inline[- ]?\w+|straight[- ]?\w+|boxer|flat[- ]?\w+|radial|crankshaft|camshaft|piston|cylinder head|brushless|bldc|outrunner|inrunner)\b/i;

/* Turn "a 5 litre v8" or "an inline six" or "a turbofan" into a spec the
   sizing can take. Deliberately blunt: it is a starting point that the
   bench and the model can both then edit, not an attempt at parsing
   English. */
export function specFromRequest(request = '') {
  const t = String(request).toLowerCase();

  if (/\b(turbofan|turbojet|turboprop|jet engine|jet\b|bypass)\b/.test(t)) {
    const spec = { ...TURBOFAN_REFERENCE };
    const bpr = t.match(/\b(?:bypass|bpr)\D{0,12}(\d{1,2}(?:\.\d)?)/);
    if (bpr) spec.bypassRatio = Number(bpr[1]);
    const dia = t.match(/(\d{1,2}(?:\.\d)?)\s*(?:m|metre|meter)\b/);
    if (dia) spec.fanDiameter = Number(dia[1]) * 1000;
    return spec;
  }

  if (/\b(brushless|bldc|outrunner|inrunner|electric motor|stator|rotor)\b/.test(t)) {
    const base = /outrunner/.test(t) ? EMOTOR_REFERENCES.outrunner_2814
      : /industrial|servo/.test(t) ? EMOTOR_REFERENCES.industrial_bldc
        : EMOTOR_REFERENCES.inrunner_540;
    const spec = { ...base };
    const kv = t.match(/\b(\d{2,4})\s*kv\b/);
    if (kv) spec.kv = Number(kv[1]);
    return spec;
  }

  /* a named engine wins over anything inferred */
  for (const [id, ref] of Object.entries(ICE_REFERENCES)) {
    const words = [id.replace(/_/g, ' '), ref.model, `${ref.maker} ${ref.model}`];
    if (words.some(w => w && t.includes(String(w).toLowerCase()))) return { ...ref };
  }

  /* otherwise: a layout and a count */
  let layout = 'inline', cylinders = 4;
  const vee = t.match(/\bv-?(\d{1,2})\b/);
  const radial = t.match(/\bradial\b(?:\D{0,10}(\d{1,2}))?/);
  const flat = t.match(/\b(?:flat|boxer)-?(\d{1,2})?\b/);
  const inline = t.match(/\b(?:inline|straight|i)-?(\d{1,2})\b/);
  const worded = t.match(new RegExp(`\\b(${Object.keys(WORD_CYLINDERS).join('|')})\\b`));

  if (vee) { layout = 'vee'; cylinders = Number(vee[1]); }
  else if (radial) { layout = 'radial'; cylinders = radial[1] ? Number(radial[1]) : 9; }
  else if (flat) { layout = 'flat'; cylinders = flat[1] ? Number(flat[1]) : 4; }
  else if (inline) { layout = 'inline'; cylinders = Number(inline[1]); }
  else if (worded) { cylinders = WORD_CYLINDERS[worded[1]]; if (/\bv\b|\bvee\b/.test(t)) layout = 'vee'; }
  if (/\b(boxer|flat)\b/.test(t)) layout = 'flat';

  cylinders = clamp(cylinders, 1, 16);
  if (layout === 'radial' && cylinders % 2 === 0) cylinders += 1;   // a single row has to be odd
  if (layout === 'vee' && cylinders % 2) cylinders += 1;
  if (cylinders === 1) layout = 'single';

  /* start from the nearest real engine of that shape so the proportions
     are somebody's rather than invented */
  const near = Object.values(ICE_REFERENCES)
    .filter(r => r.layout === layout)
    .sort((a, b) => Math.abs(a.cylinders - cylinders) - Math.abs(b.cylinders - cylinders))[0]
    || ICE_REFERENCES.toyota_2jz;

  const spec = { ...near, layout, cylinders, name: `${LAYOUTS[layout].label}${cylinders}`, journals: undefined };

  /* a stated capacity re-bores it to suit, keeping the bore/stroke ratio */
  const litres = t.match(/(\d(?:\.\d)?)\s*(?:l\b|litre|liter)/);
  if (litres) {
    const wantCC = Number(litres[1]) * 1000;
    const k = (wantCC / (sizeICE(spec).displacement)) ** (1 / 3);
    spec.bore = round(spec.bore * k); spec.stroke = round(spec.stroke * k);
    spec.rod = round(spec.rod * k); spec.chamber = round(spec.chamber * k ** 3);
  }
  return spec;
}

/* ------------------------------------------------------------------ */
/* the spec the plan carries                                           */
/* ------------------------------------------------------------------ */
/* Clamped exactly like validateWires clamps the netlist: the plan is the
   contract, and whatever wrote it — model, bench, optimiser — gets the
   same treatment. Returns null when there is no engine here, so a plan
   without one carries no key at all. */
const nameOf = raw => {
  const n = raw.name || [raw.maker, raw.model].filter(Boolean).join(' ');
  return n ? { name: String(n).slice(0, 60) } : {};
};

export function validateEngine(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = ENGINE_KINDS.includes(raw.kind) ? raw.kind : null;
  if (!kind) return null;

  /* How much of the finished object this engine is. 1 on its own, less
     when it has been dropped into something — a car carries its engine,
     it is not made of it. Stored on the spec so it survives every trip
     through validatePlan, which re-bodies engine parts from scratch and
     would otherwise blow a mounted engine back up to full size. */
  const fit = clamp(num(raw.fit, 1), 0.08, 1);

  if (kind === 'ice') {
    const layout = LAYOUTS[raw.layout] ? raw.layout : 'inline';
    const bore = clamp(num(raw.bore, 86), 10, 400);
    const stroke = clamp(num(raw.stroke, 86), 10, 400);
    /* Chamber volume is what gets STORED, because it is a dimension of a
       part somebody can machine, while a compression ratio is a
       consequence. A spec that arrives quoting the ratio — which is how
       every engine is written up — is converted here, once, and the two
       can then never disagree. */
    const swept = (Math.PI / 4) * bore * bore * stroke / 1000;
    const chamber = Number.isFinite(Number(raw.chamber))
      ? clamp(Number(raw.chamber), 1, 20000)
      : clamp(swept / (clamp(num(raw.compressionRatio, 10), 1.5, 30) - 1), 1, 20000);
    const out = {
      kind, fit, layout,
      cylinders: clamp(Math.round(num(raw.cylinders, 4)), 1, 16),
      bore, stroke,
      rod: clamp(num(raw.rod, 142), 15, 800),
      compressionHeight: clamp(num(raw.compressionHeight, 30), 0, 120),
      chamber: round(chamber),
      vAngle: clamp(num(raw.vAngle, LAYOUTS[layout].angle), 0, 180),
      redline: clamp(num(raw.redline, 6000), 500, 20000),
      fuel: raw.fuel === 'diesel' ? 'diesel' : 'petrol',
      induction: ['supercharged', 'turbocharged'].includes(raw.induction) ? raw.induction : 'na'
    };
    if (out.layout === 'vee' && out.cylinders % 2) out.cylinders += 1;
    if (out.layout === 'radial' && out.cylinders % 2 === 0) out.cylinders += 1;
    if (out.layout === 'single') out.cylinders = 1;
    if (Array.isArray(raw.journals) && raw.journals.length) {
      out.journals = raw.journals.slice(0, 16).map(v => clamp(num(v), 0, 360));
    }
    const named = raw.name || [raw.maker, raw.model].filter(Boolean).join(' ');
    if (named) out.name = String(named).slice(0, 60);
    return out;
  }

  if (kind === 'turbofan') {
    return {
      kind, fit,
      massFlow: clamp(num(raw.massFlow, 20.5), 0.5, 500),
      bypassRatio: clamp(num(raw.bypassRatio, 7), 0, 15),
      overallPressureRatio: clamp(num(raw.overallPressureRatio, 40), 2, 70),
      fanDiameter: clamp(num(raw.fanDiameter, 2600), 100, 6000),
      fanHubTipRatio: clamp(num(raw.fanHubTipRatio, 0.35), 0.1, 0.8),
      fanTipMach: clamp(num(raw.fanTipMach, 1.3), 0.4, 2),
      lpcPR: clamp(num(raw.lpcPR, 2.5), 1.05, 10),
      innerFanPR: clamp(num(raw.innerFanPR, 1.8), 1.01, 4),
      outerFanPR: clamp(num(raw.outerFanPR, 2.5), 1.01, 4),
      perStagePR: clamp(num(raw.perStagePR, 1.3), 1.05, 2),
      compAxialVelocity: clamp(num(raw.compAxialVelocity, 190), 50, 350),
      turbineAxialVelocity: clamp(num(raw.turbineAxialVelocity, 150), 50, 350),
      ...nameOf(raw)
    };
  }

  const statorOD = clamp(num(raw.statorOD, 28), 4, 600);
  return {
    kind, fit, form: raw.form === 'outrunner' ? 'outrunner' : 'inrunner',
    statorOD,
    statorID: clamp(num(raw.statorID, statorOD * 0.36), 1, statorOD - 1),
    stackLength: clamp(num(raw.stackLength, 14), 2, 400),
    slots: clamp(Math.round(num(raw.slots, 12)), 3, 72),
    poles: clamp(Math.round(num(raw.poles, 14)), 2, 80),
    magnetThickness: clamp(num(raw.magnetThickness, 2.5), 0.4, 20),
    airgap: clamp(num(raw.airgap, 0.5), 0.05, 3),
    kv: clamp(num(raw.kv, 700), 1, 20000),
    voltage: clamp(num(raw.voltage, 14.8), 0.5, 1000),
    ...nameOf(raw)
  };
}

/* ------------------------------------------------------------------ */
/* parts                                                               */
/* ------------------------------------------------------------------ */
/* The engine is sized in millimetres and the shop works in metres on a
   1.9m pedestal, so there is exactly ONE scale conversion and it happens
   here. Everything above this line is real size; everything below it is
   shop size. Getting that boundary wrong is how you end up with a 2.6m
   fan filling the room or a motor you cannot see.                      */
const SHOP_HEIGHT = 1.1;      // how tall the biggest engine part comes out

export function scaleFor(sized) {
  const span = sized.kind === 'ice' ? Math.max(sized.blockLength, sized.blockWidth, sized.blockHeight)
    : sized.kind === 'turbofan' ? Math.max(sized.fanDiameter, sized.overallLength)
      : Math.max(sized.overallDiameter, sized.stackLength) * 2.4;
  return SHOP_HEIGHT / Math.max(1, span);
}

/* Every part carries `engine_role`. That tag is what makes its geometry
   the engine's business rather than the model's — the same rule as a
   component's body coming from COMPONENTS. */
export const ENGINE_ROLES = [
  'block', 'crank', 'piston', 'rod', 'head', 'manifold', 'sump', 'flywheel',
  'crankcase', 'cylinder',
  'spinner', 'fan', 'lpc', 'hpc', 'combustor', 'hpt', 'lpt', 'shaft', 'nozzle', 'nacelle',
  'stator', 'rotor', 'magnet', 'shaft_motor', 'endbell'
];

/* `fit` is how much of the pedestal this engine is entitled to. On its own
   it is the whole object and takes all of it; dropped into the engine bay
   of a car it is one part of a bigger thing and takes a fraction. It is a
   multiplier on the ONE scale boundary rather than a second set of sizes,
   so the arithmetic upstream — bore, stroke, deck height — is untouched
   and the bench still reports the real engine. */
export function engineParts(sized, { fit = 1 } = {}) {
  if (!sized) return [];
  const k = scaleFor(sized) * clamp(num(fit, 1), 0.08, 1);
  const mm = v => round(Math.max(0.01, num(v) * k), 4);
  if (sized.kind === 'ice') return icePartsOf(sized, mm);
  if (sized.kind === 'turbofan') return turbofanPartsOf(sized, mm);
  return motorPartsOf(sized, mm);
}

function icePartsOf(e, mm) {
  const parts = [];
  const P = p => (parts.push(p), parts.length - 1);
  const alloy = 'alloy';

  /* 0 — the block. Everything hangs off it, so it is part zero and has no
     attachment, which is what validatePlan requires of a root. */
  const block = P({
    name: 'cylinder block', engine_role: 'block', shape: 'box', material: alloy,
    size: [mm(e.blockLength), mm(e.blockHeight * 0.55), mm(e.blockWidth)]
  });

  /* The crank lives INSIDE the block, on the centreline, which is both
     where it is and what stops it acting as a leg: the solver treats
     anything on the underside as holding the block up, so a crank hung
     off `bottom` settled the block down onto it and left the cylinders
     where they were — bores sunk into their own deck, nothing thrown. */
  P({
    name: 'crankshaft', engine_role: 'crank', shape: 'rod', material: 'metal',
    size: [mm(e.bore * 0.62), mm(e.blockLength * 0.98), mm(e.bore * 0.62)],
    rot: [0, 0, 90],
    attach: { to: block, face: 'inside' }
  });

  /* The sump is the leg, flush to the block: it is what the engine stands
     on, on a stand and on the pedestal both. */
  P({
    name: 'sump', engine_role: 'sump', shape: 'box', material: alloy,
    size: [mm(e.blockLength * 0.9), mm(e.bore * 0.55), mm(e.blockWidth * 0.8)],
    attach: { to: block, face: 'bottom' }
  });

  /* the cylinders. One array per bank — a V has two, rolled apart by the
     bank angle; a radial is a ring. This is the part of the spec models
     reliably get wrong and arrays reliably get right. */
  const banks = e.banks;
  const half = e.vAngle / 2;
  for (let b = 0; b < banks; b++) {
    const perBank = Math.ceil(e.cylinders / banks);
    const sign = b === 0 ? 1 : -1;
    const bankZ = banks > 1 ? round(sign * mm(e.blockWidth * 0.22), 4) : 0;
    const common = {
      engine_role: 'cylinder', shape: 'cylinder', material: alloy,
      size: [mm(e.bore * 1.15), mm(e.deckHeight * 0.55), mm(e.bore * 1.15)]
    };
    const cyl = P(e.layout === 'radial'
      ? {
        ...common, name: 'cylinder',
        array: { mode: 'ring', count: e.cylinders, radius: mm(e.crankRadius) },
        attach: { to: block, face: 'top' }
      }
      : {
        ...common, name: banks > 1 ? `cylinder bank ${b + 1}` : 'cylinder',
        array: { mode: 'row', count: perBank, spacing: mm(e.boreSpacing) },
        /* The banks sit either side of the crank along z, so the roll that
           opens them into a V is about X. Rolling about Z instead tilted
           them along the LENGTH of the engine — every bore leaning towards
           the flywheel, which is not a V of anything. */
        rot: banks > 1 ? [round(-sign * half, 1), 0, 0] : undefined,
        attach: { to: block, face: 'top', dz: bankZ }
      });

    /* The pistons ride INSIDE the bores, so in the shaded view they are
       not visible at all — which is correct, and is why the bench has an
       x-ray and a section. Arrayed exactly like the cylinders they run in,
       so instance n of one is instance n of the other and the firing order
       lines up without anybody having to match them by name. */
    P({
      name: 'piston', engine_role: 'piston', shape: 'cylinder', material: alloy,
      size: [mm(e.bore * 0.96), mm(e.bore * 0.8), mm(e.bore * 0.96)],
      rot: banks > 1 ? [round(-sign * half, 1), 0, 0] : undefined,
      array: e.layout === 'radial'
        ? { mode: 'ring', count: e.cylinders, radius: mm(e.crankRadius) }
        : { mode: 'row', count: perBank, spacing: mm(e.boreSpacing) },
      attach: { to: cyl, face: 'inside' }
    });

    /* How far above the block deck the head sits, and how far outboard the
       bank angle carries it. All of it in shop metres off the cylinder the
       bank is made of, so it moves when the bore does. */
    const halfRad = (half * Math.PI) / 180;
    const cylH = mm(e.deckHeight * 0.55);
    const bankRise = mm(e.bore * 0.25);

    /* The head and the manifold hang off the BLOCK, not off the bank.
       Hung off an arrayed, rolled cylinder they inherit two things that
       are not theirs: the parent's inflated rotated half-extent, which
       floats them a bank's height into the air, and instance one's place
       in the row, which slides them off the front of the engine. Neither
       throws — a V8 just came out with two heads crossed in the sky above
       it. Off the block, the standoff is arithmetic anyone can check. */
    const bankLift = round(cylH * Math.cos(halfRad) + bankRise, 4);
    const bankOut = banks > 1 ? round(sign * cylH * Math.sin(halfRad), 4) : 0;

    P({
      name: banks > 1 ? `cylinder head ${b + 1}` : 'cylinder head',
      engine_role: 'head', shape: 'box', material: alloy,
      size: [mm(e.blockLength * 0.92), mm(e.bore * 0.5), mm(e.bore * 1.4)],
      rot: banks > 1 ? [round(-sign * half, 1), 0, 0] : undefined,
      attach: { to: block, face: 'top', dy: bankLift, dz: round(bankZ + bankOut, 4) }
    });

    P({
      name: banks > 1 ? `exhaust manifold ${b + 1}` : 'exhaust manifold',
      engine_role: 'manifold', shape: 'rod', material: 'metal',
      size: [mm(e.bore * 0.5), mm(e.blockLength * 0.9), mm(e.bore * 0.5)],
      rot: [0, 0, 90],
      attach: { to: block, face: b === 0 ? 'front' : 'back', dy: round(bankLift * 0.6, 4), dz: bankZ }
    });
  }

  P({
    name: 'flywheel', engine_role: 'flywheel', shape: 'cylinder', material: 'metal',
    size: [mm(e.stroke * 2.6), mm(e.bore * 0.35), mm(e.stroke * 2.6)],
    rot: [0, 0, 90],
    attach: { to: block, face: 'left' }
  });

  return parts;
}

function turbofanPartsOf(e, mm) {
  const parts = [];
  const P = p => (parts.push(p), parts.length - 1);
  const L = e.overallLength;

  /* The engine is laid out along X, which is why every station is rotated
     onto its side: a cylinder's own axis is +Y and an axial machine's is
     the flow direction. */
  const disc = (name, role, dia, len, material = 'alloy') => ({
    name, engine_role: role, shape: 'cylinder', material,
    size: [mm(dia), mm(len), mm(dia)], rot: [0, 0, 90]
  });

  /* The fan cowl, not a case around the whole engine. On a high-bypass
     turbofan the cowl covers the fan and the front of the core and the
     core nacelle runs out behind it — which is both what one looks like
     and the only version you can read: a casing the full length of the
     engine is a drum with everything that makes it an engine inside it. */
  const cowlLength = L * 0.45;
  const nacelle = P({
    name: 'nacelle casing', engine_role: 'nacelle', shape: 'cylinder', material: 'alloy',
    size: [mm(e.fanDiameter * 1.08), mm(cowlLength), mm(e.fanDiameter * 1.08)],
    rot: [0, 0, 90]
  });

  P({
    name: 'spinner', engine_role: 'spinner', shape: 'cone', material: 'alloy',
    size: [mm(e.fanHubDiameter * 0.9), mm(e.fanDiameter * 0.28), mm(e.fanHubDiameter * 0.9)],
    /* A cone's tip is its local +Y, and +90 about Z lays that along -X —
       which is forward, into the airflow. A nose cone pointing backwards
       and a tailcone pointing forwards is the same mistake twice and both
       render perfectly happily. */
    rot: [0, 0, 90],
    attach: { to: nacelle, face: 'left' }
  });

  P({
    ...disc('fan', 'fan', e.fanDiameter, e.fanDiameter * 0.12),
    attach: { to: nacelle, face: 'left', dx: mm(L * 0.04) }
  });

  /* The core, station by station, each one sized off its own annulus. The
     FIRST one goes `inside` the nacelle and the rest chain off it — hung
     off the nacelle's right face instead, the whole core came out behind
     the engine in a row, like a bottle with a stack of coins beside it.
     A core is inside its casing; that is what a casing is. */
  let prev = nacelle;
  let first = true;
  for (const st of e.stations) {
    const isTurbine = st.id === 'hpt' || st.id === 'lpt';
    prev = P({
      ...disc(st.label, st.id, st.tipDiameter, e.fanDiameter * 0.09 * Math.max(1, st.stages / 2),
        isTurbine ? 'metal' : 'alloy'),
      array: { mode: 'row', count: clamp(st.stages, 2, 8), spacing: mm(e.fanDiameter * 0.055) },
      attach: first
        ? { to: nacelle, face: 'inside', dx: round(-mm(cowlLength) * 0.5 + mm(L * 0.14), 4) }
        : { to: prev, face: 'right' }
    });
    first = false;
    if (st.id === 'hpc') {
      prev = P({
        ...disc('combustor', 'combustor', e.stations[1].tipDiameter * 1.25, e.combustorLength, 'metal'),
        attach: { to: prev, face: 'right' }
      });
    }
  }

  P({
    name: 'core shaft', engine_role: 'shaft', shape: 'rod', material: 'metal',
    size: [mm(e.fanHubDiameter * 0.35), mm(e.coreLength), mm(e.fanHubDiameter * 0.35)],
    rot: [0, 0, 90],
    attach: { to: nacelle, face: 'inside' }
  });

  P({
    name: 'exhaust nozzle', engine_role: 'nozzle', shape: 'cone', material: 'metal',
    size: [mm(e.nozzleDiameter), mm(e.fanDiameter * 0.34), mm(e.nozzleDiameter)],
    rot: [0, 0, -90],
    attach: { to: prev, face: 'right' }
  });

  return parts;
}

function motorPartsOf(e, mm) {
  const parts = [];
  const P = p => (parts.push(p), parts.length - 1);

  const stator = P({
    name: 'stator stack', engine_role: 'stator', shape: 'cylinder', material: 'metal',
    size: [mm(e.statorOD), mm(e.stackLength), mm(e.statorOD)]
  });

  P({
    name: e.form === 'outrunner' ? 'rotor can' : 'rotor',
    engine_role: 'rotor', shape: 'cylinder', material: 'alloy',
    size: [mm(e.rotorOD), mm(e.stackLength * 1.15), mm(e.rotorOD)],
    attach: { to: stator, face: 'inside' }
  });

  P({
    name: 'magnets', engine_role: 'magnet', shape: 'box', material: 'metal',
    size: [mm(e.magnetThickness * 2.2), mm(e.stackLength), mm(e.rotorOD * 0.22)],
    array: { mode: 'ring', count: clamp(e.poles, 2, 8), radius: mm(e.rotorOD * 0.44) },
    /* A ring array only goes radial off a SIDE face — off `top` the solver
       stacks the whole ring on the lid, and the magnets came out standing
       on the end of the can like a crown. They belong round the wall. */
    attach: { to: stator, face: 'front' }
  });

  P({
    name: 'shaft', engine_role: 'shaft_motor', shape: 'rod', material: 'metal',
    size: [mm(e.statorID * 0.8), mm(e.stackLength * 2.6), mm(e.statorID * 0.8)],
    attach: { to: stator, face: 'inside' }
  });

  P({
    name: 'end bell', engine_role: 'endbell', shape: 'cylinder', material: 'alloy',
    size: [mm(e.overallDiameter), mm(e.stackLength * 0.25), mm(e.overallDiameter)],
    attach: { to: stator, face: 'bottom' }
  });

  return parts;
}

/* ------------------------------------------------------------------ */
/* motion                                                              */
/* ------------------------------------------------------------------ */
/* Kinematics, not animation. What turns, how fast, about which axis, and
   for a piston, where it is at a given crank angle — all of it arithmetic
   so it can be checked in node. world.js turns this into transforms; it
   is the only thing that knows what a transform is. */
export function engineMotion(plan) {
  const e = plan?.engine;
  if (!e) return [];
  const sized = sizeEngine(e);
  const parts = planPartsOf(plan);
  const out = [];
  const find = role => parts.findIndex(p => p?.engine_role === role);

  if (sized.kind === 'ice') {
    /* An idle, not the redline. A V8 on the pedestal turning at 6500 is a
       blur and reads as a bug; at idle you can see the firing order. */
    const rpm = clamp(sized.redline * 0.12, 60, 1200);
    for (const role of ['crank', 'flywheel']) {
      const i = find(role);
      if (i >= 0) out.push({ part: i, kind: 'spin', axis: 'x', rpm });
    }
    const k = scaleFor(sized);
    const all = sized.firingAngles.map(a => ((a / 2) % 360) * Math.PI / 180);
    let bank = 0;
    parts.forEach((p, i) => {
      if (p?.engine_role !== 'piston') return;
      /* Each bank is one arrayed part, and the banks come out in order, so
         bank n holds cylinders n·perBank … — slicing the phase list the
         same way is what makes the second bank of a V fire on its own
         cylinders rather than repeating the first bank's. */
      const phases = all.slice(bank * sized.perBank, (bank + 1) * sized.perBank);
      bank++;
      out.push({
        part: i, kind: 'reciprocate', axis: 'y', rpm,
        throw: sized.crankThrow, rod: sized.rod,
        travel: round(sized.stroke * k, 4),
        phases: phases.length ? phases : all
      });
    });
    return out;
  }

  if (sized.kind === 'turbofan') {
    const low = sized.fanRpm, high = sized.fanRpm * 3.1;
    for (const [role, rpm] of [['fan', low], ['lpc', low], ['lpt', low], ['hpc', high], ['hpt', high], ['spinner', low], ['shaft', low]]) {
      const i = find(role);
      if (i >= 0) out.push({ part: i, kind: 'spin', axis: 'x', rpm });
    }
    return out;
  }

  const rotor = find('rotor'), mag = find('magnet');
  if (rotor >= 0) out.push({ part: rotor, kind: 'spin', axis: 'y', rpm: sized.noLoadRpm * 0.02 });
  if (mag >= 0) out.push({ part: mag, kind: 'spin', axis: 'y', rpm: sized.noLoadRpm * 0.02 });
  return out;
}

/* Where a piston sits, 0 at the bottom of its travel and 1 at the top. */
export function pistonPhase(theta, throwR, rod) {
  const top = throwR + rod, bottom = rod - throwR;
  const at = pistonAt(theta, throwR, rod);
  return top === bottom ? 0 : clamp((at - bottom) / (top - bottom), 0, 1);
}

/* ------------------------------------------------------------------ */
/* what is wrong with it                                               */
/* ------------------------------------------------------------------ */
/* Same finding shape as circuit.js, so an engine fault lands in the bench
   list beside an electrical one with no special case anywhere.

   The standing rule from engineer.test.mjs applies here hardest of all:
   NO FALSE POSITIVES. Every rule below is tested twice, once on a build
   that has the fault and once on one that has not, because an engineer
   who is wrong twice gets ignored the third time. */
const F = (id, severity, title, why, gain, patch) =>
  ({ id, kind: 'mechanical', severity, title, why, gain, patch });

/* Bands that are engineering, not taste. */
export const LIMITS = {
  crPetrol: [7, 14],       // naturally aspirated pump fuel
  crBoosted: [4.5, 10],    // supercharged or turbocharged — low on purpose
  crDiesel: [14, 23],
  pistonSpeed: 25,         // m/s mean, above which production engines do not live
  rodStroke: 1.4,          // below this the rod angle is punishing the bore
  fanDiameter: 3500        // mm — an engine under a wing has to clear the ground
};

function planPartsOf(plan) {
  return (plan?.steps || []).filter(s => s?.part).map(s => s.part);
}

export function analyseEngine(plan) {
  const spec = plan?.engine;
  if (!spec) return [];
  const sized = sizeEngine(spec);
  const parts = planPartsOf(plan);
  const has = role => parts.some(p => p?.engine_role === role);
  const out = [];

  if (sized.kind === 'ice') {
    const [lo, hi] = sized.fuel === 'diesel' ? LIMITS.crDiesel
      : sized.induction !== 'na' ? LIMITS.crBoosted
        : LIMITS.crPetrol;
    const cr = sized.compressionRatio;
    if (cr < lo || cr > hi) {
      /* the chamber that WOULD put it in the middle of the band */
      const want = round(sized.sweptPerCyl / ((lo + hi) / 2 - 1), 1);
      out.push(F('cr', 'fault',
        `The compression ratio is ${cr}:1`,
        cr > hi
          ? `${sized.fuel === 'diesel' ? 'that' : 'a petrol engine'} detonates well below ${hi}:1 — ${sized.chamber}cc of chamber on ${round(sized.sweptPerCyl)}cc of swept volume is not enough`
          : `under ${lo}:1 it will not make useful power — the chamber is far too big for the bore`,
        `a ${want}cc chamber puts it at ${round((sized.sweptPerCyl + want) / want)}:1`,
        { kind: 'edit-spec', set: { chamber: want } }));
    }

    if (sized.meanPistonSpeed > LIMITS.pistonSpeed) {
      const want = Math.round((LIMITS.pistonSpeed * 60) / (2 * sized.stroke / 1000) / 100) * 100;
      out.push(F('piston-speed', 'fault',
        `The pistons are doing ${sized.meanPistonSpeed} m/s at the redline`,
        `${sized.stroke}mm of stroke at ${sized.redline}rpm — production engines stop at about ${LIMITS.pistonSpeed} m/s and this one throws a rod`,
        `${want}rpm is the most that stroke will take`,
        { kind: 'edit-spec', set: { redline: want } }));
    }

    if (sized.rodStrokeRatio < LIMITS.rodStroke) {
      const want = round(sized.stroke * 1.6);
      out.push(F('rod-ratio', 'improvement',
        `The rods are short for the stroke`,
        `a rod/stroke ratio of ${sized.rodStrokeRatio} swings the rod hard across the bore and loads the piston skirt`,
        `a ${want}mm rod puts it at 1.6, which is where most of these live`,
        { kind: 'edit-spec', set: { rod: want } }));
    }

    if (sized.boreSpacing < sized.bore) {
      out.push(F('bore-spacing', 'fault',
        'The bores intersect',
        `${sized.boreSpacing}mm between centres on a ${sized.bore}mm bore leaves no iron between the cylinders`,
        'a bore under the spacing is the only way this seals',
        null));
    }

    if (sized.layout === 'vee' && sized.cylinders % 2) {
      out.push(F('bank-count', 'fault',
        `A V${sized.cylinders} has an odd number of cylinders`,
        'a V engine is two banks, so one bank has a cylinder the other has not',
        `V${sized.cylinders + 1} is the engine this wants to be`,
        { kind: 'edit-spec', set: { cylinders: sized.cylinders + 1 } }));
    }
    if (sized.layout === 'radial' && sized.cylinders % 2 === 0) {
      out.push(F('radial-count', 'fault',
        `A single-row radial cannot have ${sized.cylinders} cylinders`,
        'the four-stroke cycle only comes round evenly on a single row with an odd count — that is why every one of them is 5, 7 or 9',
        `${sized.cylinders + 1} cylinders fires evenly`,
        { kind: 'edit-spec', set: { cylinders: sized.cylinders + 1 } }));
    }

    if (parts.length) {
      if (!has('crank')) {
        out.push(F('no-crank', 'fault', 'There is no crankshaft',
          'the pistons have nothing to push against — an engine without a crank is a set of pumps',
          'a crankshaft on the block centreline under the bores', null));
      }
      if (!has('head')) {
        out.push(F('no-head', 'fault', 'The cylinders are open at the top',
          'nothing closes the combustion chamber, so there is nothing to compress against',
          'a cylinder head on top of every bank', null));
      }
      if (!has('manifold')) {
        out.push(F('no-manifold', 'note', 'Nothing carries the exhaust away',
          'the ports open to nowhere',
          'a manifold down the side of each head', null));
      }
    }

    out.push(F('capacity', 'note',
      `${sized.displacement}cc ${sized.layoutLabel}${sized.cylinders}`,
      `${sized.bore} × ${sized.stroke}mm, ${cr}:1, firing ${sized.firingOrder.join('-')}`,
      `${sized.meanPistonSpeed} m/s mean piston speed at ${sized.redline}rpm`, null));
    return sortFindings(out);
  }

  if (sized.kind === 'turbofan') {
    if (sized.fanDiameter > LIMITS.fanDiameter) {
      out.push(F('ground-clearance', 'fault',
        `A ${round(sized.fanDiameter / 1000, 2)}m fan will not clear the ground`,
        `under a wing there is about half a metre to play with, which caps the nacelle at ${LIMITS.fanDiameter / 1000}m`,
        `a ${LIMITS.fanDiameter}mm fan fits and keeps the bypass ratio`,
        { kind: 'edit-spec', set: { fanDiameter: LIMITS.fanDiameter } }));
    }

    const by = id => sized.stations.find(s => s.id === id);
    const lpc = by('lpc'), hpc = by('hpc'), hpt = by('hpt'), lpt = by('lpt');
    if (lpt && hpt && lpt.meanRadius < hpt.meanRadius) {
      out.push(F('spool-radii', 'fault',
        'The low-pressure turbine is inside the high-pressure one',
        'the flow leaves the HPT and has to turn inwards to reach a smaller LPT, which is not how the gas path runs',
        'the LPT sits outboard of the HPT — it is slower and takes a bigger radius to do the same work',
        null));
    }
    if (lpc && hpc && lpc.meanRadius < hpc.meanRadius) {
      out.push(F('comp-radii', 'fault',
        'The low-pressure compressor is smaller than the high-pressure one',
        'the air gets denser as it is compressed, so every stage after the last is smaller, never bigger',
        'the LPC is the larger of the two',
        null));
    }
    if (lpc && lpc.meanRadius > sized.innerFanMeanRadius * 1.2) {
      out.push(F('lpc-fan', 'improvement',
        'The booster is much bigger than the fan root feeding it',
        `an LPC mean radius of ${lpc.meanRadius}mm behind a ${sized.innerFanMeanRadius}mm fan root means the duct has to flare outwards`,
        'keeping the booster inside 1.2× the fan root keeps the duct straight',
        null));
    }
    if (sized.fanWork <= 0) {
      out.push(F('cycle-work', 'fault',
        'The turbines do not take back what the compressors put in',
        `${sized.turbineWork} kJ/kg out of the turbines against ${sized.compressorWork} kJ/kg into the compressors — there is nothing left to turn the fan and the engine will not hold itself over`,
        'the turbine inlet temperature has to come up, or the overall pressure ratio has to come down',
        null));
    } else if (sized.impliedFanPR < 1.1) {
      out.push(F('fan-work', 'improvement',
        'There is barely enough surplus work to turn the fan',
        `${sized.fanWork} kJ/kg of core surplus spread over ${sized.bypassMassFlow} kg/s of bypass is a fan pressure ratio of only ${sized.impliedFanPR}`,
        'a smaller bypass ratio puts the same surplus through less air and gets a useful fan pressure ratio',
        null));
    }
    if (parts.length) {
      if (!has('combustor')) {
        out.push(F('no-combustor', 'fault', 'There is nothing burning anything',
          'the air goes from the compressor straight into the turbine, so no work is added and the engine cannot even turn itself',
          'a combustor between the HPC and the HPT', null));
      }
      if (!has('nozzle')) {
        out.push(F('no-nozzle', 'improvement', 'The core has no nozzle',
          'the gas has to be accelerated on the way out or none of the energy becomes thrust',
          'a convergent nozzle on the back of the LPT', null));
      }
    }

    out.push(F('thrust', 'note',
      `about ${sized.thrust} kN`,
      `${sized.totalMassFlow} kg/s at bypass ${sized.bypassRatio}, overall pressure ratio ${sized.overallPressureRatio}, ${sized.stages} stages`,
      `fan ${sized.fanDiameter}mm turning ${Math.round(sized.fanRpm)}rpm, tip speed ${sized.tipSpeed} m/s`, null));
    return sortFindings(out);
  }

  /* the motor */
  /* The magnets have to fit the ring they are glued to. On an inrunner
     that ring is what is left of the rotor once the shaft is through it,
     and magnets thicker than the ring is a rotor made entirely of magnet
     with no iron behind it to carry the flux. */
  if (sized.rotorID <= 0 || sized.rotorOD - sized.rotorID < 0.2) {
    out.push(F('magnet-fit', 'fault',
      'The magnets do not fit the rotor',
      `${sized.magnetThickness}mm of magnet each side of a ${round(sized.rotorOD)}mm rotor leaves no rotor behind them`,
      `${round(Math.max(0.4, sized.rotorOD * 0.18))}mm magnets fit and still leave iron`,
      { kind: 'edit-spec', set: { magnetThickness: round(Math.max(0.4, sized.rotorOD * 0.18)) } }));
  }
  if (sized.coggingSteps < sized.slots * 2) {
    out.push(F('cogging', 'improvement',
      `A ${sized.slots}/${sized.poles} motor cogs`,
      `slots and poles share a factor, so all ${sized.coggingSteps} torque steps line up and the motor notches as it turns`,
      'a 12/14 or 12/10 combination gives 84 and 60 steps and turns smoothly',
      { kind: 'edit-spec', set: { poles: sized.slots + 2 } }));
  }
  if (sized.rotorTipSpeed > 120) {
    out.push(F('tip-speed', 'fault',
      `The rotor surface is doing ${sized.rotorTipSpeed} m/s`,
      `${sized.kv}Kv on ${sized.voltage}V is ${sized.noLoadRpm}rpm, and the magnets come off a can well before that`,
      `about ${Math.round(120 / sized.rotorTipSpeed * sized.kv)}Kv is what this rotor will hold`,
      { kind: 'edit-spec', set: { kv: Math.round(120 / sized.rotorTipSpeed * sized.kv) } }));
  }
  out.push(F('motor', 'note',
    `${sized.slots}/${sized.poles} ${sized.form}`,
    `${sized.kv}Kv on ${sized.voltage}V is ${sized.noLoadRpm}rpm off load, ${sized.torqueConstant} Nm per amp`,
    `${sized.coggingSteps} cogging steps per turn`, null));
  return sortFindings(out);
}

function sortFindings(list) {
  const rank = { fault: 0, improvement: 1, note: 2 };
  return list.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/* Applying a spec patch. The engine spec is a single object rather than a
   part, so it cannot go through editPart — this is its equivalent, and it
   clamps for the same reason. */
export function applyEnginePatch(spec, set) {
  return validateEngine({ ...(spec || {}), ...(set || {}) });
}

/* ------------------------------------------------------------------ */
/* words                                                               */
/* ------------------------------------------------------------------ */
export function describeEngine(plan) {
  const spec = plan?.engine;
  if (!spec) return '';
  const e = sizeEngine(spec);
  if (e.kind === 'ice') {
    return [
      `${e.displacement}cc (${e.litres}L) ${e.layoutLabel}${e.cylinders}${e.banks > 1 ? ` at ${e.vAngle}°` : ''}`,
      `${e.bore} × ${e.stroke}mm on a ${e.rod}mm rod, ${e.compressionRatio}:1`,
      `firing ${e.firingOrder.join('-')}, ${e.meanPistonSpeed} m/s at ${e.redline}rpm`,
      `block ${e.blockLength} × ${e.blockWidth} × ${e.blockHeight}mm, deck ${e.deckHeight}mm`
    ].join('\n');
  }
  if (e.kind === 'turbofan') {
    return [
      `${e.fanDiameter}mm fan, bypass ${e.bypassRatio}, overall pressure ratio ${e.overallPressureRatio}`,
      `${e.totalMassFlow} kg/s total, ${e.massFlow} through the core, about ${e.thrust} kN`,
      `${e.stations.map(s => `${s.id.toUpperCase()} ${s.stages}`).join(', ')} — ${e.stages} stages on ${e.spools} spools`,
    `${e.turbineWork} kJ/kg out, ${e.compressorWork} in, ${e.fanWork} left for the fan`,
      `fan ${Math.round(e.fanRpm)}rpm, tip speed ${e.tipSpeed} m/s`
    ].join('\n');
  }
  return [
    `${e.slots} slots, ${e.poles} poles, ${e.form}`,
    `${e.statorOD}mm stator × ${e.stackLength}mm stack, ${e.airgap}mm gap`,
    `${e.kv}Kv — ${e.noLoadRpm}rpm off ${e.voltage}V, ${e.torqueConstant} Nm/A`
  ].join('\n');
}

/* Folded into the planning and critique prompts, exactly like
   electricalBlock. The point of it is the LAST paragraph: the model does
   not size an engine here, it says which one, and the shop does the
   arithmetic. */
export function engineBlock(request = '') {
  if (!ENGINE_RE.test(String(request))) return '';
  return `
THIS IS AN ENGINE, AND THE SHOP KNOWS HOW ENGINES GO TOGETHER
A piston engine is a block with the crank on its centreline, cylinders standing on
top of it in one row, two rows at a bank angle, or a ring around the crank, a head
closing every bank and a manifold down the side. Deck height, bore spacing, block
length and block width all fall out of the bore, the stroke and the rod — none of
them is a free choice.
A turbofan is a stack of stages on two shafts inside one casing: spinner, fan,
booster, high-pressure compressor, COMBUSTOR, high-pressure turbine, low-pressure
turbine, nozzle, in that order along the flow. Nothing in it is a box.
A brushless motor is a slotted stator, a magnet ring at one air gap from it, a shaft
and an end bell.

DO NOT give dimensions for any of it. Give the engine spec — kind, layout, cylinder
count, bore, stroke, rod, chamber volume, redline (or mass flow, bypass ratio and
overall pressure ratio; or slots, poles and Kv) — and tag each part with its
engine_role. The shop sizes every part from those numbers, the way it already knows
what a resistor looks like. A size you invent here will be thrown away.`;
}
