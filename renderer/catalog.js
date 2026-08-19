/* =====================================================================
   THE PARTS CATALOGUE — what things are made of, and how they go together.

   The offline planner used to hold eight archetypes of three or four
   primitives each: a lamp was a cylinder, a rod and a cone; a car was a
   box, two rings and a wedge. Ask for anything not on that list and you
   got a generic stack, and the domain fallback was worse — it took the
   part NAMES for a domain and stacked every one of them vertically on the
   part before it, which is how a request for a car came back as a drum
   with a wheel balanced on top.

   Two things are wrong with that and this file fixes both.

   FIRST, THE VOCABULARY IS TOO SMALL. A car is not four parts. It is a
   chassis, a floor, a body, a cabin, wheels on real hubs, a grille, lights,
   an exhaust. Every archetype here is written out properly, in the shop's
   own attach/array vocabulary and using the whole shape library rather than
   the six primitives that existed when the first ones were written.

   SECOND, AND THE REASON FOR THE FILE: A REQUEST CAN NAME MORE THAN ONE
   THING. "A car with a V12 engine" is a HOST and a SUBSYSTEM, and the
   planner could only ever pick one branch — so it built a beautiful V12
   and no car at all, or a car with nothing in it. `compose` mounts one
   into the other: the subsystem's parts are renumbered onto the end of the
   host's, its root is bolted to a NAMED MOUNT on the host, and the whole
   block is scaled to the room the host actually has for it. That is the
   same arithmetic `crewplan.mergeSubplans` does for four specialists, for
   the same reason, and it is tested the same way — on the indices, not on
   the absence of a crash.

   Imports nothing. An archetype is data, a mount is data, and composition
   is arithmetic over part indices, so all of it is checkable in node.
   ===================================================================== */

/* Sizes are metres and rotations are DEGREES — validatePlan converts to
   radians on the way in, the same as every other part spec that is written
   by hand. Part 0 is the root: it has no attachment and it is what stands
   on the pedestal. */

const p = (name, shape, material, size, attach, extra = {}) => ({
  name, shape, material, size: size.slice(),
  ...(attach ? { attach } : {}),
  ...extra
});

/* What turns when the thing is switched on. The motion system already
   drives an engine's crank and pistons; a part tagged here joins it, so a
   car's wheels turn when its engine does and a drone's props spin. */
export const MOVERS = ['wheel', 'rotor', 'prop', 'gear', 'drum', 'turntable'];

/* ------------------------------------------------------------------ */
/* the archetypes                                                      */
/* ------------------------------------------------------------------ */
/* `words` is what somebody would call it. `note` is one line of how the
   thing actually goes together, and it goes into the planning prompt —
   the model is far better at filling in a structure than at inventing one.
   `mounts` are the named places a subsystem can be bolted to, with the
   span they have room for, in metres. */

export const ARCHETYPES = [
  /* ---------------- things that drive ---------------------------- */
  {
    id: 'car', class: 'vehicle', label: 'car',
    words: ['car', 'automobile', 'motorcar', 'sedan', 'coupe', 'hotrod', 'roadster', 'racecar', 'kart', 'buggy'],
    note: 'A car is a chassis with wheels hung off both ends, a body sitting on the chassis behind the engine bay, and a cabin on the body. The engine goes at the front, on the chassis, ahead of the body.',
    mounts: { engine: { to: 0, face: 'top', dx: -0.44, dy: 0.02, span: 0.52 }, circuit: { to: 3, face: 'top', span: 0.3 } },
    parts: [
      p('chassis', 'box', 'metal', [1.42, 0.1, 0.6]),
      p('wheel', 'torus', 'plastic', [0.42, 0.16, 0.42], { to: 0, face: 'left', dx: 0.06 },
        { rot: [0, 0, 90], array: { mode: 'mirror_z', radius: 0.31, count: 2 }, moves: 'wheel' }),
      p('wheel', 'torus', 'plastic', [0.42, 0.16, 0.42], { to: 0, face: 'right', dx: -0.06 },
        { rot: [0, 0, 90], array: { mode: 'mirror_z', radius: 0.31, count: 2 }, moves: 'wheel' }),
      p('body', 'box', 'painted', [0.76, 0.24, 0.58], { to: 0, face: 'top', dx: 0.3 }),
      p('cabin', 'trapezoid', 'glass', [0.48, 0.22, 0.54], { to: 3, face: 'top', dx: 0.04 }),
      p('boot lid', 'panel', 'painted', [0.3, 0.05, 0.56], { to: 3, face: 'top', dx: 0.32 }),
      /* The nose is a bumper across the front with the lights ON it — a
         grille hoop standing proud of the chassis and lights hung off THAT
         read as a cowcatcher. */
      p('bumper', 'box', 'metal', [0.07, 0.13, 0.58], { to: 0, face: 'left' }),
      p('grille', 'ring_plate', 'metal', [0.2, 0.05, 0.2], { to: 6, face: 'left' }, { rot: [0, 0, 90] }),
      p('headlight', 'dome', 'glass', [0.13, 0.07, 0.13], { to: 6, face: 'left' },
        { rot: [0, 0, -90], array: { mode: 'mirror_z', radius: 0.21, count: 2 } }),
      p('exhaust', 'pipe', 'metal', [0.66, 0.08, 0.08], { to: 0, face: 'front', dx: 0.18 })
    ]
  },
  {
    id: 'truck', class: 'vehicle', label: 'truck',
    words: ['truck', 'lorry', 'pickup', 'van', 'tipper', 'flatbed', 'hauler'],
    note: 'A truck is a long chassis, a cab over the front axle, a flat bed behind it, and wheels in pairs — two at the front, four at the back.',
    mounts: { engine: { to: 0, face: 'top', dx: -0.56, dy: 0.02, span: 0.46 } },
    parts: [
      p('chassis rail', 'ibeam', 'metal', [1.6, 0.12, 0.12], null,
        { array: { mode: 'mirror_z', radius: 0.24, count: 2 } }),
      p('crossmember', 'channel', 'metal', [0.1, 0.08, 0.5], { to: 0, face: 'top' },
        { array: { mode: 'row', count: 4, spacing: 0.38 } }),
      p('cab', 'box', 'painted', [0.5, 0.44, 0.56], { to: 1, face: 'top', dx: -0.44 }),
      p('windscreen', 'panel', 'glass', [0.05, 0.28, 0.5], { to: 2, face: 'left', dy: 0.06 }),
      p('bed', 'panel', 'wood', [0.86, 0.06, 0.56], { to: 1, face: 'top', dx: 0.34 }),
      p('bed side', 'panel', 'metal', [0.86, 0.18, 0.05], { to: 4, face: 'top' },
        { array: { mode: 'mirror_z', radius: 0.26, count: 2 } }),
      p('front wheel', 'torus', 'plastic', [0.4, 0.16, 0.4], { to: 0, face: 'left', dx: 0.1 },
        { rot: [0, 0, 90], array: { mode: 'mirror_z', radius: 0.3, count: 2 }, moves: 'wheel' }),
      p('rear wheel', 'torus', 'plastic', [0.42, 0.2, 0.42], { to: 0, face: 'right', dx: -0.12 },
        { rot: [0, 0, 90], array: { mode: 'mirror_z', radius: 0.3, count: 2 }, moves: 'wheel' })
    ]
  },
  {
    id: 'motorcycle', class: 'vehicle', label: 'motorcycle',
    words: ['motorcycle', 'motorbike', 'bike', 'scooter', 'moped', 'chopper'],
    note: 'A motorcycle is a spine frame between two wheels, the engine slung under the spine, a tank on top of it and a seat behind that.',
    mounts: { engine: { to: 0, face: 'bottom', dy: -0.04, span: 0.34 } },
    parts: [
      p('frame spine', 'ibeam', 'metal', [0.9, 0.1, 0.1]),
      p('front wheel', 'torus', 'plastic', [0.46, 0.1, 0.46], { to: 0, face: 'left', dy: -0.16 },
        { rot: [0, 0, 90], moves: 'wheel' }),
      p('rear wheel', 'torus', 'plastic', [0.46, 0.13, 0.46], { to: 0, face: 'right', dy: -0.16 },
        { rot: [0, 0, 90], moves: 'wheel' }),
      p('fuel tank', 'capsule', 'painted', [0.34, 0.2, 0.26], { to: 0, face: 'top', dx: -0.06 }),
      p('seat', 'trapezoid', 'plastic', [0.3, 0.1, 0.22], { to: 0, face: 'top', dx: 0.28 }),
      p('fork', 'rod', 'metal', [0.07, 0.44, 0.07], { to: 0, face: 'left', dy: 0.12 }, { rot: [0, 0, 18] }),
      p('handlebar', 'rod', 'metal', [0.05, 0.44, 0.05], { to: 5, face: 'top' }, { rot: [90, 0, 0] }),
      p('exhaust', 'pipe', 'metal', [0.6, 0.08, 0.08], { to: 0, face: 'front', dy: -0.12 })
    ]
  },
  {
    id: 'bicycle', class: 'vehicle', label: 'bicycle',
    words: ['bicycle', 'cycle', 'pushbike', 'bmx'],
    note: 'A bicycle is a triangulated frame between two wheels, with a seat post up the back of the triangle and forks down to the front hub.',
    parts: [
      p('down tube', 'rod', 'metal', [0.05, 0.8, 0.05], null, { rot: [0, 0, 68] }),
      p('front wheel', 'torus', 'plastic', [0.56, 0.05, 0.56], { to: 0, face: 'left', dy: -0.2 }, { rot: [0, 0, 90], moves: 'wheel' }),
      p('rear wheel', 'torus', 'plastic', [0.56, 0.05, 0.56], { to: 0, face: 'right', dy: -0.2 }, { rot: [0, 0, 90], moves: 'wheel' }),
      p('top tube', 'rod', 'metal', [0.04, 0.5, 0.04], { to: 0, face: 'top' }, { rot: [0, 0, 96] }),
      p('seat tube', 'rod', 'metal', [0.04, 0.34, 0.04], { to: 3, face: 'top', dx: 0.18 }, { rot: [0, 0, 12] }),
      p('saddle', 'trapezoid', 'plastic', [0.2, 0.05, 0.1], { to: 4, face: 'top' }),
      p('handlebar', 'rod', 'metal', [0.04, 0.4, 0.04], { to: 3, face: 'top', dx: -0.22 }, { rot: [90, 0, 0] }),
      p('chainring', 'gear', 'metal', [0.22, 0.03, 0.22], { to: 0, face: 'bottom' }, { rot: [0, 0, 90], moves: 'gear' })
    ]
  },
  {
    id: 'train', class: 'vehicle', label: 'locomotive',
    words: ['train', 'locomotive', 'engine shed', 'railcar', 'tram', 'wagon'],
    note: 'A locomotive is a long underframe on bogies, a boiler or body barrel along it, a cab at one end and a chimney at the other.',
    mounts: { engine: { to: 0, face: 'top', dx: -0.3, span: 0.4 } },
    parts: [
      p('underframe', 'box', 'metal', [1.5, 0.12, 0.5]),
      p('bogie wheel', 'torus', 'metal', [0.34, 0.08, 0.34], { to: 0, face: 'front', dy: -0.1 },
        { rot: [0, 0, 90], array: { mode: 'row', count: 3, spacing: 0.42 }, moves: 'wheel' }),
      p('bogie wheel', 'torus', 'metal', [0.34, 0.08, 0.34], { to: 0, face: 'back', dy: -0.1 },
        { rot: [0, 0, 90], array: { mode: 'row', count: 3, spacing: 0.42 }, moves: 'wheel' }),
      p('boiler', 'capsule', 'painted', [1.0, 0.44, 0.44], { to: 0, face: 'top', dx: -0.18 }),
      p('cab', 'box', 'painted', [0.4, 0.42, 0.48], { to: 0, face: 'top', dx: 0.5 }),
      p('cab roof', 'panel', 'metal', [0.46, 0.04, 0.52], { to: 4, face: 'top' }),
      p('chimney', 'funnel', 'metal', [0.18, 0.22, 0.18], { to: 3, face: 'top', dx: -0.34, dy: -0.2 }),
      p('dome', 'dome', 'metal', [0.2, 0.12, 0.2], { to: 3, face: 'top', dx: 0.06 }),
      p('buffer', 'pipe', 'metal', [0.12, 0.1, 0.1], { to: 0, face: 'left' },
        { array: { mode: 'mirror_z', radius: 0.18, count: 2 } })
    ]
  },
  {
    id: 'tank', class: 'vehicle', label: 'tracked vehicle',
    words: ['tank', 'bulldozer', 'excavator', 'digger', 'tracked', 'crawler'],
    note: 'A tracked vehicle is a hull with a road-wheel bogie each side, a turret or cab on top, and a boom or barrel off the front of that.',
    mounts: { engine: { to: 0, face: 'top', dx: 0.4, span: 0.42 } },
    parts: [
      p('hull', 'box', 'metal', [1.2, 0.3, 0.66]),
      p('track guard', 'channel', 'metal', [1.24, 0.16, 0.12], { to: 0, face: 'front' },
        { array: { mode: 'mirror_z', radius: 0.36, count: 2 } }),
      p('road wheel', 'torus', 'metal', [0.26, 0.1, 0.26], { to: 0, face: 'front', dy: -0.12 },
        { rot: [0, 0, 90], array: { mode: 'row', count: 5, spacing: 0.24 }, moves: 'wheel' }),
      p('road wheel', 'torus', 'metal', [0.26, 0.1, 0.26], { to: 0, face: 'back', dy: -0.12 },
        { rot: [0, 0, 90], array: { mode: 'row', count: 5, spacing: 0.24 }, moves: 'wheel' }),
      p('turret', 'hex', 'painted', [0.52, 0.24, 0.5], { to: 0, face: 'top', dx: -0.1 }, { moves: 'turntable' }),
      p('barrel', 'pipe', 'metal', [0.72, 0.1, 0.1], { to: 4, face: 'left' }),
      p('hatch', 'dome', 'metal', [0.18, 0.06, 0.18], { to: 4, face: 'top' })
    ]
  },

  /* ---------------- things that fly ------------------------------- */
  {
    id: 'airplane', class: 'aircraft', label: 'aeroplane',
    words: ['plane', 'airplane', 'aeroplane', 'aircraft', 'jet', 'airliner', 'fighter', 'biplane'],
    note: 'An aeroplane is a fuselage with a wing through the middle, a tailplane and fin at the back, a nose at the front and gear underneath. Engines hang under the wing.',
    mounts: { engine: { to: 1, face: 'bottom', dx: -0.2, span: 0.34 } },
    parts: [
      p('fuselage', 'capsule', 'painted', [1.5, 0.3, 0.3]),
      p('wing', 'panel', 'painted', [0.42, 0.05, 1.5], { to: 0, face: 'top', dx: -0.05, dy: -0.1 }),
      p('tailplane', 'panel', 'painted', [0.24, 0.04, 0.62], { to: 0, face: 'right', dx: -0.06 }),
      p('fin', 'trapezoid', 'painted', [0.26, 0.3, 0.04], { to: 2, face: 'top' }),
      p('nose', 'nosecone', 'painted', [0.3, 0.28, 0.3], { to: 0, face: 'left' }, { rot: [0, 0, 90] }),
      p('main gear', 'rod', 'metal', [0.05, 0.24, 0.05], { to: 1, face: 'bottom', dz: 0.34 },
        { array: { mode: 'mirror_z', radius: 0.34, count: 2 } }),
      p('wheel', 'torus', 'plastic', [0.16, 0.06, 0.16], { to: 5, face: 'bottom' },
        { rot: [0, 0, 90], array: { mode: 'mirror_z', radius: 0.34, count: 2 }, moves: 'wheel' }),
      p('aileron', 'panel', 'metal', [0.1, 0.03, 0.4], { to: 1, face: 'right', dz: 0.4 },
        { array: { mode: 'mirror_z', radius: 0.48, count: 2 } })
    ]
  },
  {
    id: 'drone', class: 'aircraft', label: 'quadcopter',
    words: ['drone', 'quadcopter', 'quadrotor', 'multirotor', 'uav', 'fpv'],
    note: 'A quadcopter is a centre body with four arms out to four motors, a propeller on each, and legs underneath. The props on one diagonal turn against the other.',
    mounts: { circuit: { to: 0, face: 'top', span: 0.26 }, engine: { to: 2, face: 'top', span: 0.16 } },
    parts: [
      p('centre plate', 'panel', 'metal', [0.34, 0.03, 0.34]),
      /* A RING, not a quad. Four arms radiate, and a quad array on a side
         face throws its radial offset away — all four came out in the same
         place pointing the same way, which is a drone with one arm. */
      p('arm', 'rod', 'metal', [0.05, 0.4, 0.05], { to: 0, face: 'front' },
        { array: { mode: 'ring', count: 4, radius: 0.22 }, rot: [0, 0, 90] }),
      /* The standoff is what keeps them up there: a part on a `top` face is
         subject to gravity, and a motor on the end of an arm has nothing
         under it — all four dropped to the pedestal and the drone came out
         as a plate with its motors lying around it on the floor. */
      p('motor', 'spool', 'alloy', [0.11, 0.09, 0.11], { to: 1, face: 'top', dy: 0.02 },
        { array: { mode: 'ring', count: 4, radius: 0.22 } }),
      p('propeller', 'panel', 'plastic', [0.32, 0.02, 0.05], { to: 2, face: 'top', dy: 0.01 },
        { array: { mode: 'ring', count: 4, radius: 0.22 }, moves: 'prop' }),
      p('battery', 'box', 'plastic', [0.2, 0.06, 0.1], { to: 0, face: 'bottom' }),
      /* Off the CENTRE PLATE, not off the arms: hung under an arm that is
         itself rotated, the legs came out shorter than the battery and the
         thing stood on its battery with a 3:1 tip ratio. */
      p('leg', 'rod', 'plastic', [0.035, 0.26, 0.035], { to: 0, face: 'bottom' },
        { array: { mode: 'quad', radius: 0.19, count: 4 } }),
      p('canopy', 'dome', 'painted', [0.22, 0.11, 0.22], { to: 0, face: 'top' })
    ]
  },
  {
    id: 'helicopter', class: 'aircraft', label: 'helicopter',
    words: ['helicopter', 'chopper', 'rotorcraft', 'gyrocopter'],
    note: 'A helicopter is a cabin with a tail boom off the back, a mast and rotor on top, a tail rotor on the fin and skids underneath.',
    mounts: { engine: { to: 0, face: 'top', dx: 0.1, span: 0.3 } },
    parts: [
      p('cabin', 'capsule', 'painted', [0.62, 0.42, 0.46]),
      p('tail boom', 'pipe', 'metal', [0.86, 0.12, 0.12], { to: 0, face: 'right' }),
      p('fin', 'trapezoid', 'painted', [0.16, 0.26, 0.04], { to: 1, face: 'right' }),
      p('mast', 'rod', 'metal', [0.06, 0.18, 0.06], { to: 0, face: 'top' }),
      p('main rotor', 'panel', 'metal', [1.3, 0.02, 0.09], { to: 3, face: 'top' }, { moves: 'rotor' }),
      p('rotor blade', 'panel', 'metal', [1.3, 0.02, 0.09], { to: 3, face: 'top', dy: 0.02 }, { rot: [0, 90, 0], moves: 'rotor' }),
      p('tail rotor', 'panel', 'metal', [0.3, 0.02, 0.05], { to: 2, face: 'front' }, { rot: [0, 0, 90], moves: 'rotor' }),
      p('skid', 'rod', 'metal', [0.04, 0.66, 0.04], { to: 0, face: 'bottom' },
        { rot: [0, 0, 90], array: { mode: 'mirror_z', radius: 0.2, count: 2 } })
    ]
  },
  {
    id: 'rocket', class: 'rocket', label: 'rocket',
    words: ['rocket', 'missile', 'launcher', 'booster', 'launchvehicle'],
    note: 'A rocket is a long body tube, a nose cone on top, fins arrayed around the bottom and a nozzle underneath.',
    mounts: { engine: { to: 0, face: 'bottom', span: 0.4 } },
    parts: [
      p('body tube', 'pipe', 'metal', [0.36, 1.3, 0.36]),
      p('nose cone', 'nosecone', 'painted', [0.36, 0.42, 0.36], { to: 0, face: 'top' }),
      p('fin', 'trapezoid', 'metal', [0.26, 0.3, 0.03], { to: 0, face: 'front', dy: -0.5 },
        { array: { mode: 'ring', count: 4, radius: 0.2 } }),
      p('nozzle', 'funnel', 'metal', [0.3, 0.26, 0.3], { to: 0, face: 'bottom' }, { rot: [180, 0, 0] }),
      p('band', 'washer', 'painted', [0.38, 0.05, 0.38], { to: 0, face: 'top', dy: -0.5 })
    ]
  },
  {
    id: 'satellite', class: 'spacecraft', label: 'satellite',
    words: ['satellite', 'cubesat', 'probe', 'orbiter', 'spacecraft'],
    note: 'A satellite is a bus box with solar panels out each side on booms, a dish on one face and thrusters on the opposite one.',
    mounts: { circuit: { to: 0, face: 'inside', span: 0.24 } },
    parts: [
      p('bus', 'box', 'alloy', [0.42, 0.42, 0.42]),
      p('boom', 'rod', 'metal', [0.03, 0.22, 0.03], { to: 0, face: 'left' },
        { rot: [0, 0, 90], array: { mode: 'mirror_x', radius: 0.32, count: 2 } }),
      p('solar panel', 'panel', 'glass', [0.66, 0.02, 0.34], { to: 1, face: 'left' },
        { array: { mode: 'mirror_x', radius: 0.62, count: 2 } }),
      p('dish', 'bowl', 'painted', [0.34, 0.16, 0.34], { to: 0, face: 'top' }),
      p('feed horn', 'funnel', 'metal', [0.08, 0.12, 0.08], { to: 3, face: 'top' }, { rot: [180, 0, 0] }),
      p('thruster', 'funnel', 'metal', [0.09, 0.1, 0.09], { to: 0, face: 'bottom' },
        { rot: [180, 0, 0], array: { mode: 'quad', radius: 0.14, count: 4 } })
    ]
  },

  /* ---------------- things that float ----------------------------- */
  {
    id: 'boat', class: 'vessel', label: 'boat',
    words: ['boat', 'ship', 'yacht', 'trawler', 'tug', 'ferry', 'hull'],
    note: 'A boat is a hull with a deck on it, a cabin on the deck, a mast or funnel above that, and a rudder and propeller at the stern.',
    mounts: { engine: { to: 1, face: 'top', dx: 0.1, span: 0.36 } },
    parts: [
      /* Flat-bottomed, not a V. A hull narrowing to a keel stands on a
         knife edge and falls over on the pedestal — which is true of a
         real boat too, and the shop has nowhere to put a cradle. */
      p('hull', 'trapezoid', 'painted', [1.4, 0.34, 0.52]),
      p('deck', 'panel', 'wood', [1.36, 0.05, 0.5], { to: 0, face: 'top' }),
      p('cabin', 'box', 'painted', [0.44, 0.26, 0.4], { to: 1, face: 'top', dx: 0.18 }),
      p('wheelhouse window', 'panel', 'glass', [0.04, 0.14, 0.36], { to: 2, face: 'left' }),
      p('funnel', 'pipe', 'painted', [0.14, 0.24, 0.14], { to: 2, face: 'top', dx: 0.1 }),
      p('mast', 'rod', 'metal', [0.04, 0.5, 0.04], { to: 1, face: 'top', dx: -0.34 }),
      /* Level with the hull, not below it. Anything of the hull's that
         reaches past its bottom is what the whole boat then stands on, and
         a hull balanced on its own propeller falls over immediately. */
      p('propeller', 'panel', 'alloy', [0.2, 0.02, 0.05], { to: 0, face: 'right' },
        { rot: [0, 0, 90], moves: 'prop' }),
      p('rudder', 'panel', 'metal', [0.14, 0.2, 0.03], { to: 0, face: 'right', dy: 0.04 })
    ]
  },
  {
    id: 'submarine', class: 'vessel', label: 'submarine',
    words: ['submarine', 'sub', 'submersible', 'torpedo'],
    note: 'A submarine is a long pressure hull, a conning tower on top, dive planes each side and a propeller and rudder at the tail.',
    parts: [
      p('pressure hull', 'capsule', 'metal', [1.5, 0.36, 0.36]),
      p('conning tower', 'trapezoid', 'metal', [0.26, 0.24, 0.14], { to: 0, face: 'top' }),
      p('periscope', 'rod', 'metal', [0.03, 0.2, 0.03], { to: 1, face: 'top' }),
      p('dive plane', 'panel', 'metal', [0.16, 0.03, 0.3], { to: 0, face: 'front', dx: -0.4 },
        { array: { mode: 'mirror_z', radius: 0.2, count: 2 } }),
      p('tail plane', 'panel', 'metal', [0.14, 0.03, 0.26], { to: 0, face: 'right' },
        { array: { mode: 'ring', count: 4, radius: 0.16 } }),
      p('propeller', 'panel', 'alloy', [0.26, 0.02, 0.05], { to: 0, face: 'right', dx: 0.06 },
        { rot: [0, 0, 90], moves: 'prop' })
    ]
  },

  /* ---------------- things you sit at ----------------------------- */
  {
    id: 'table', class: 'table', label: 'table',
    words: ['table', 'desk', 'worktable', 'workbench', 'bench', 'dining'],
    note: 'A table is a top with four legs under its corners and rails tying the legs together near the top.',
    parts: [
      p('top', 'panel', 'wood', [1.3, 0.06, 0.86]),
      p('rail', 'box', 'wood', [1.14, 0.09, 0.06], { to: 0, face: 'bottom' },
        { array: { mode: 'mirror_z', radius: 0.34, count: 2 } }),
      p('end rail', 'box', 'wood', [0.06, 0.09, 0.7], { to: 0, face: 'bottom' },
        { array: { mode: 'mirror_x', radius: 0.58, count: 2 } }),
      p('leg', 'rod', 'wood', [0.09, 0.7, 0.09], { to: 0, face: 'bottom' },
        { array: { mode: 'quad', radius: 0.5, count: 4 } })
    ]
  },
  {
    id: 'chair', class: 'chair', label: 'chair',
    words: ['chair', 'stool', 'seat', 'armchair', 'barstool'],
    note: 'A chair is a seat on four legs with a back up from the rear edge and a stretcher between the legs.',
    parts: [
      p('seat', 'panel', 'wood', [0.46, 0.05, 0.44]),
      p('leg', 'rod', 'wood', [0.06, 0.44, 0.06], { to: 0, face: 'bottom' },
        { array: { mode: 'quad', radius: 0.17, count: 4 } }),
      /* The back is ONE piece off the seat's back edge, raised by a real
         standoff. Two posts with a rest bridging them needs the rest to
         pair with the posts, and one part never pairs with two — it landed
         on post number one and sat on top of it like a hat. */
      p('back post', 'rod', 'wood', [0.05, 0.52, 0.05], { to: 0, face: 'left', dy: 0.24 },
        { array: { mode: 'mirror_z', radius: 0.17, count: 2 } }),
      p('back rest', 'panel', 'wood', [0.05, 0.34, 0.42], { to: 0, face: 'left', dy: 0.36 }),
      p('stretcher', 'rod', 'wood', [0.04, 0.4, 0.04], { to: 0, face: 'bottom', dy: -0.3 },
        { rot: [0, 0, 90], array: { mode: 'mirror_z', radius: 0.17, count: 2 } })
    ]
  },
  {
    id: 'shelf', class: 'shelf', label: 'shelving',
    words: ['shelf', 'shelve', 'bookshelf', 'bookcase', 'rack', 'shelving', 'cabinet', 'cupboard'],
    note: 'Shelving is two uprights with boards between them, a back panel keeping it square and a plinth at the bottom.',
    parts: [
      /* Off a plinth, with each board at its own height. A `row` array
         spreads along X and a side face throws that offset away entirely,
         so four shelves attached to an upright came out in exactly the
         same place — one board with three hidden inside it. */
      p('plinth', 'box', 'wood', [1.0, 0.09, 0.36]),
      p('upright', 'panel', 'wood', [0.05, 1.2, 0.36], { to: 0, face: 'top' },
        { array: { mode: 'mirror_x', radius: 0.48, count: 2 } }),
      p('back panel', 'panel', 'cardboard', [1.0, 1.18, 0.02], { to: 0, face: 'top', dy: 0.55, dz: -0.17 }),
      p('bottom shelf', 'panel', 'wood', [0.94, 0.05, 0.34], { to: 0, face: 'top', dy: 0.24 }),
      p('middle shelf', 'panel', 'wood', [0.94, 0.05, 0.34], { to: 0, face: 'top', dy: 0.56 }),
      p('upper shelf', 'panel', 'wood', [0.94, 0.05, 0.34], { to: 0, face: 'top', dy: 0.88 }),
      p('top shelf', 'panel', 'wood', [0.98, 0.05, 0.36], { to: 0, face: 'top', dy: 1.16 })
    ]
  },
  {
    id: 'bed', class: 'bed', label: 'bed',
    words: ['bed', 'bunk', 'cot', 'daybed', 'mattress'],
    note: 'A bed is a frame on legs with slats across it, a mattress on the slats and a headboard at one end.',
    parts: [
      /* ONE frame, then legs under it. Two side rails with a quad of legs
         gave all four legs to the first rail — the arrays do not pair, so
         the second rail had nothing under it and lay on the floor. */
      p('frame', 'box', 'wood', [1.5, 0.12, 0.92]),
      p('side rail', 'box', 'wood', [1.52, 0.16, 0.06], { to: 0, face: 'top' },
        { array: { mode: 'mirror_z', radius: 0.44, count: 2 } }),
      p('slat', 'panel', 'wood', [0.07, 0.03, 0.84], { to: 0, face: 'top' },
        { array: { mode: 'row', count: 6, spacing: 0.24 } }),
      p('mattress', 'box', 'plastic', [1.42, 0.16, 0.82], { to: 2, face: 'top' }),
      p('leg', 'rod', 'wood', [0.09, 0.26, 0.09], { to: 0, face: 'bottom' },
        { array: { mode: 'quad', radius: 0.52, count: 4 } }),
      p('headboard', 'panel', 'wood', [0.05, 0.5, 0.9], { to: 0, face: 'left' })
    ]
  },
  {
    id: 'lamp', class: 'lamp', label: 'lamp',
    words: ['lamp', 'light', 'lantern', 'sconce', 'luminaire', 'nightlight', 'desklamp'],
    note: 'A lamp is a weighted base, a stem up from it, a shade on top of the stem and a bulb inside the shade.',
    mounts: { circuit: { to: 0, face: 'top', span: 0.22 } },
    parts: [
      p('base', 'ring_plate', 'metal', [0.44, 0.06, 0.44]),
      p('collar', 'knob', 'metal', [0.14, 0.08, 0.14], { to: 0, face: 'top' }),
      p('stem', 'rod', 'metal', [0.1, 0.8, 0.1], { to: 1, face: 'top' }),
      p('shade', 'funnel', 'painted', [0.5, 0.34, 0.5], { to: 2, face: 'top' }, { rot: [180, 0, 0] }),
      /* Hanging out of the mouth of the shade, not buried in it. A bulb
         entirely inside its shade is invisible AND reads to the optimiser
         as stock doing no work, which is a note nobody wants on a lamp. */
      p('bulb', 'sphere', 'glass', [0.18, 0.18, 0.18], { to: 2, face: 'top', dy: -0.12 }),
      p('switch', 'knob', 'plastic', [0.07, 0.05, 0.07], { to: 0, face: 'front' })
    ]
  },

  /* ---------------- things that work ------------------------------ */
  {
    id: 'robotarm', class: 'robot', label: 'robot arm',
    words: ['robot arm', 'manipulator', 'gripper', 'arm', 'palletiser', 'welder'],
    note: 'A robot arm is a heavy base, a shoulder that turns on it, an upper arm, a forearm and a gripper — each link lighter than the one carrying it.',
    mounts: { circuit: { to: 0, face: 'front', span: 0.24 } },
    parts: [
      p('base', 'ring_plate', 'metal', [0.56, 0.1, 0.56]),
      p('turntable', 'spool', 'alloy', [0.34, 0.16, 0.34], { to: 0, face: 'top' }, { moves: 'turntable' }),
      p('shoulder', 'box', 'painted', [0.24, 0.26, 0.3], { to: 1, face: 'top' }),
      p('upper arm', 'ibeam', 'painted', [0.16, 0.62, 0.16], { to: 2, face: 'top' }, { rot: [0, 0, 24] }),
      p('elbow', 'pipe', 'alloy', [0.18, 0.2, 0.18], { to: 3, face: 'top' }, { rot: [90, 0, 0] }),
      p('forearm', 'ibeam', 'painted', [0.13, 0.5, 0.13], { to: 4, face: 'top' }, { rot: [0, 0, -40] }),
      p('wrist', 'spool', 'alloy', [0.13, 0.1, 0.13], { to: 5, face: 'top' }),
      p('gripper jaw', 'angle', 'metal', [0.06, 0.16, 0.05], { to: 6, face: 'top' },
        { array: { mode: 'mirror_x', radius: 0.05, count: 2 } })
    ]
  },
  {
    id: 'crane', class: 'crane', label: 'crane',
    words: ['crane', 'gantry', 'hoist', 'derrick', 'jib', 'lift'],
    note: 'A crane is a base, a lattice tower, a jib out one side with a counterweight on the other, and a hook on a cable from the jib.',
    parts: [
      p('base', 'box', 'metal', [0.7, 0.12, 0.7]),
      p('tower', 'ibeam', 'metal', [0.22, 1.2, 0.22], { to: 0, face: 'top' }),
      p('brace', 'angle', 'metal', [0.05, 0.4, 0.05], { to: 1, face: 'front' },
        { array: { mode: 'row', count: 3, spacing: 0.36 }, rot: [0, 0, 40] }),
      p('jib', 'ibeam', 'painted', [1.0, 0.14, 0.14], { to: 1, face: 'top', dx: 0.34 }),
      p('counterweight', 'box', 'metal', [0.24, 0.2, 0.24], { to: 3, face: 'left' }),
      p('cable', 'rod', 'metal', [0.02, 0.5, 0.02], { to: 3, face: 'bottom', dx: 0.3 }),
      p('hook block', 'trapezoid', 'painted', [0.12, 0.14, 0.1], { to: 5, face: 'bottom' })
    ]
  },
  {
    id: 'gearbox', class: 'mechanism', label: 'gearbox',
    words: ['gearbox', 'transmission', 'reducer', 'drivetrain', 'differential', 'geartrain'],
    note: 'A gearbox is a housing with an input shaft and an output shaft in bearings, gears in mesh between them and a cover plate on top.',
    mounts: { engine: { to: 0, face: 'left', span: 0.4 } },
    parts: [
      p('housing', 'box', 'alloy', [0.7, 0.5, 0.44]),
      p('bearing boss', 'pipe', 'alloy', [0.16, 0.1, 0.16], { to: 0, face: 'front' },
        { rot: [90, 0, 0], array: { mode: 'row', count: 2, spacing: 0.3 } }),
      p('input shaft', 'rod', 'metal', [0.07, 0.6, 0.07], { to: 0, face: 'front', dx: -0.15 }, { rot: [90, 0, 0], moves: 'gear' }),
      p('drive gear', 'gear', 'metal', [0.28, 0.07, 0.28], { to: 2, face: 'inside' }, { rot: [90, 0, 0], moves: 'gear' }),
      p('driven gear', 'gear', 'metal', [0.4, 0.07, 0.4], { to: 0, face: 'front', dx: 0.15, dy: -0.06 }, { rot: [90, 0, 0], moves: 'gear' }),
      p('output shaft', 'rod', 'metal', [0.08, 0.5, 0.08], { to: 4, face: 'inside' }, { rot: [90, 0, 0], moves: 'gear' }),
      p('cover plate', 'panel', 'alloy', [0.68, 0.04, 0.42], { to: 0, face: 'top' }),
      p('filler plug', 'hex', 'metal', [0.08, 0.05, 0.08], { to: 6, face: 'top', dx: 0.2 })
    ]
  },
  {
    id: 'windmill', class: 'turbine', label: 'wind turbine',
    words: ['windmill', 'wind turbine', 'turbine tower', 'windpump', 'weathervane'],
    note: 'A wind turbine is a tapered tower on a foundation, a nacelle on top of it, and a hub with three blades on the front of the nacelle.',
    mounts: { engine: { to: 2, face: 'inside', span: 0.24 } },
    parts: [
      p('foundation', 'ring_plate', 'metal', [0.6, 0.08, 0.6]),
      p('tower', 'funnel', 'painted', [0.28, 1.2, 0.28], { to: 0, face: 'top' }, { rot: [180, 0, 0] }),
      p('nacelle', 'capsule', 'painted', [0.4, 0.2, 0.2], { to: 1, face: 'top' }, { rot: [0, 0, 90] }),
      p('hub', 'nosecone', 'painted', [0.18, 0.16, 0.18], { to: 2, face: 'left' }, { rot: [0, 0, 90], moves: 'rotor' }),
      p('blade', 'trapezoid', 'glass', [0.1, 0.8, 0.03], { to: 3, face: 'front' },
        { array: { mode: 'ring', count: 3, radius: 0.12 }, moves: 'rotor' })
    ]
  },
  {
    id: 'pump', class: 'pump', label: 'pump',
    words: ['pump', 'compressor unit', 'blower', 'impeller housing', 'hydraulic'],
    note: 'A pump is a volute casing on a baseplate, an inlet on the axis, an outlet off the side and a motor behind it on the same shaft.',
    mounts: { engine: { to: 0, face: 'right', span: 0.34 } },
    parts: [
      p('baseplate', 'panel', 'metal', [0.8, 0.06, 0.42]),
      p('casing', 'spool', 'alloy', [0.24, 0.44, 0.44], { to: 0, face: 'top', dx: -0.16 }),
      p('inlet', 'pipe', 'metal', [0.18, 0.16, 0.16], { to: 1, face: 'left' }),
      p('outlet', 'pipe', 'metal', [0.13, 0.3, 0.13], { to: 1, face: 'top' }),
      p('flange', 'ring_plate', 'metal', [0.22, 0.03, 0.22], { to: 3, face: 'top' }),
      p('impeller', 'gear', 'alloy', [0.3, 0.06, 0.3], { to: 1, face: 'inside' }, { rot: [0, 0, 90], moves: 'rotor' }),
      p('coupling guard', 'channel', 'painted', [0.2, 0.16, 0.18], { to: 0, face: 'top', dx: 0.2 })
    ]
  },
  {
    id: 'bridge', class: 'structure', label: 'bridge',
    words: ['bridge', 'truss', 'viaduct', 'span', 'gantry frame', 'trestle'],
    note: 'A truss bridge is two chords held apart by diagonal web members, a deck between them and piers under each end.',
    parts: [
      p('bottom chord', 'ibeam', 'metal', [1.6, 0.1, 0.1], null,
        { array: { mode: 'mirror_z', radius: 0.34, count: 2 } }),
      p('deck', 'panel', 'wood', [1.56, 0.05, 0.62], { to: 0, face: 'top' }),
      p('post', 'angle', 'metal', [0.06, 0.42, 0.06], { to: 0, face: 'top' },
        { array: { mode: 'row', count: 5, spacing: 0.34 } }),
      /* Off the DECK at post height, not off a post. Two chords and five
         posts do not pair, so both chords landed on post number one and
         the solver then dropped them to find the rest — a deliberate
         standoff says what the drawing says: the chord is up there. */
      p('top chord', 'ibeam', 'metal', [1.5, 0.09, 0.09], { to: 1, face: 'top', dy: 0.4 },
        { array: { mode: 'mirror_z', radius: 0.34, count: 2 } }),
      p('diagonal', 'rod', 'metal', [0.04, 0.5, 0.04], { to: 2, face: 'front' },
        { array: { mode: 'row', count: 4, spacing: 0.34 }, rot: [0, 0, 40] }),
      p('pier', 'trapezoid', 'metal', [0.34, 0.3, 0.62], { to: 0, face: 'bottom' },
        { array: { mode: 'mirror_x', radius: 0.6, count: 2 } })
    ]
  },
  {
    id: 'tower', class: 'structure', label: 'tower',
    words: ['tower', 'mast', 'pylon', 'lattice', 'antenna', 'lighthouse'],
    note: 'A tower is four legs raked in to a platform at the top, with bracing between them every few courses.',
    parts: [
      p('footing', 'ring_plate', 'metal', [0.8, 0.07, 0.8]),
      p('leg', 'angle', 'metal', [0.08, 1.3, 0.08], { to: 0, face: 'top' },
        { array: { mode: 'quad', radius: 0.28, count: 4 }, rot: [0, 0, 4] }),
      p('bracing', 'rod', 'metal', [0.03, 0.5, 0.03], { to: 1, face: 'front' },
        { array: { mode: 'row', count: 4, spacing: 0.3 }, rot: [0, 0, 60] }),
      p('platform', 'ring_plate', 'metal', [0.5, 0.05, 0.5], { to: 1, face: 'top' }),
      p('railing', 'pipe', 'metal', [0.5, 0.03, 0.5], { to: 3, face: 'top', dy: 0.14 }),
      p('beacon', 'dome', 'glass', [0.16, 0.12, 0.16], { to: 3, face: 'top' })
    ]
  },

  /* ---------------- things you use --------------------------------- */
  {
    id: 'speaker', class: 'speaker', label: 'speaker',
    words: ['speaker', 'loudspeaker', 'monitor', 'subwoofer', 'boombox', 'soundbar'],
    note: 'A speaker is a sealed cabinet with a woofer low on the baffle, a tweeter above it, a port beside them and feet underneath.',
    mounts: { circuit: { to: 0, face: 'back', span: 0.24 } },
    parts: [
      p('cabinet', 'box', 'wood', [0.42, 0.72, 0.36]),
      p('baffle', 'panel', 'painted', [0.4, 0.7, 0.03], { to: 0, face: 'front' }),
      p('woofer', 'bowl', 'plastic', [0.28, 0.1, 0.28], { to: 1, face: 'front', dy: -0.16 }, { rot: [-90, 0, 0] }),
      p('tweeter', 'dome', 'alloy', [0.1, 0.05, 0.1], { to: 1, face: 'front', dy: 0.22 }, { rot: [-90, 0, 0] }),
      p('port', 'pipe', 'plastic', [0.08, 0.12, 0.08], { to: 1, face: 'front', dy: 0.06 }, { rot: [90, 0, 0] }),
      p('foot', 'knob', 'plastic', [0.06, 0.04, 0.06], { to: 0, face: 'bottom' },
        { array: { mode: 'quad', radius: 0.14, count: 4 } })
    ]
  },
  {
    id: 'camera', class: 'camera', label: 'camera',
    words: ['camera', 'dslr', 'camcorder', 'webcam', 'telescope', 'periscope'],
    note: 'A camera is a body with a lens barrel out the front, a viewfinder hump on top, a grip one side and a tripod boss underneath.',
    parts: [
      p('body', 'box', 'plastic', [0.4, 0.26, 0.18]),
      p('lens barrel', 'pipe', 'alloy', [0.22, 0.26, 0.22], { to: 0, face: 'front' }, { rot: [90, 0, 0] }),
      p('lens hood', 'funnel', 'plastic', [0.26, 0.1, 0.26], { to: 1, face: 'front' }, { rot: [-90, 0, 0] }),
      p('front element', 'dome', 'glass', [0.2, 0.05, 0.2], { to: 1, face: 'front' }, { rot: [-90, 0, 0] }),
      p('prism hump', 'trapezoid', 'plastic', [0.14, 0.08, 0.14], { to: 0, face: 'top' }),
      p('grip', 'capsule', 'plastic', [0.1, 0.24, 0.16], { to: 0, face: 'left' }),
      p('shutter', 'knob', 'metal', [0.05, 0.03, 0.05], { to: 5, face: 'top' }),
      /* Inside the body, not under it. A 3cm boss on the underside is what
         the whole camera then stands on, and it falls straight over. */
      p('tripod boss', 'hex', 'metal', [0.06, 0.03, 0.06], { to: 0, face: 'inside', dy: -0.1 })
    ]
  },
  {
    id: 'clock', class: 'clock', label: 'clock',
    words: ['clock', 'watch', 'timer', 'escapement', 'pendulum', 'sundial'],
    note: 'A clock is a case with a dial in it, hands on a centre arbor, a gear train behind the dial and a pendulum below.',
    mounts: { circuit: { to: 1, face: 'back', span: 0.2 } },
    parts: [
      /* A mantel clock. The case alone is a ring standing on its rim with a
         pendulum swinging below it, which tips over the moment it is set
         down — so it gets the plinth a mantel clock actually has. */
      p('plinth', 'box', 'wood', [0.5, 0.1, 0.26]),
      p('case', 'pipe', 'wood', [0.54, 0.16, 0.54], { to: 0, face: 'top' }, { rot: [90, 0, 0] }),
      p('dial', 'ring_plate', 'painted', [0.46, 0.03, 0.46], { to: 1, face: 'front' }, { rot: [90, 0, 0] }),
      p('hour hand', 'trapezoid', 'metal', [0.14, 0.03, 0.01], { to: 2, face: 'front' }, { rot: [90, 0, 0], moves: 'gear' }),
      p('minute hand', 'trapezoid', 'metal', [0.22, 0.02, 0.01], { to: 2, face: 'front', dy: 0.01 }, { rot: [90, 0, 60], moves: 'gear' }),
      p('gear train', 'gear', 'metal', [0.2, 0.03, 0.2], { to: 1, face: 'inside' }, { rot: [90, 0, 0], moves: 'gear' }),
      p('pendulum rod', 'rod', 'metal', [0.02, 0.3, 0.02], { to: 1, face: 'inside', dy: -0.06 }),
      p('bob', 'washer', 'metal', [0.12, 0.03, 0.12], { to: 6, face: 'bottom' }, { rot: [90, 0, 0] })
    ]
  },
  {
    id: 'guitar', class: 'instrument', label: 'guitar',
    words: ['guitar', 'bass', 'ukulele', 'banjo', 'instrument', 'violin'],
    note: 'A guitar is a body, a neck out of it, a fingerboard on the neck, a headstock at the end and strings from bridge to nut.',
    parts: [
      /* On a stand, because a guitar does not stand up on its own — stood
         on the edge of its body it topples, and the shop has no wall to
         lean it against. */
      p('stand', 'ring_plate', 'metal', [0.42, 0.04, 0.42]),
      p('body', 'capsule', 'wood', [0.6, 0.5, 0.12], { to: 0, face: 'top' }),
      p('soundhole', 'ring_plate', 'painted', [0.18, 0.02, 0.18], { to: 1, face: 'front' }, { rot: [90, 0, 0] }),
      p('neck', 'box', 'wood', [0.09, 0.66, 0.05], { to: 1, face: 'top' }),
      p('fingerboard', 'panel', 'plastic', [0.08, 0.64, 0.02], { to: 3, face: 'front' }),
      p('fret', 'rod', 'metal', [0.01, 0.08, 0.01], { to: 4, face: 'front' },
        { rot: [0, 0, 90], array: { mode: 'row', count: 6, spacing: 0.09 } }),
      p('headstock', 'trapezoid', 'wood', [0.12, 0.16, 0.04], { to: 3, face: 'top' }),
      /* On the FRONT of the headstock. A row array on a left or right face
         has its offset thrown away by the face placement, so all three
         tuners came out in the same hole. */
      p('tuner', 'knob', 'metal', [0.03, 0.05, 0.03], { to: 6, face: 'front' },
        { array: { mode: 'row', count: 3, spacing: 0.05 } }),
      p('bridge', 'box', 'wood', [0.12, 0.03, 0.04], { to: 1, face: 'front', dy: -0.16 })
    ]
  },
  {
    id: 'enclosure', class: 'enclosure', label: 'enclosure',
    words: ['box', 'crate', 'case', 'enclosure', 'housing', 'bin', 'chest', 'container'],
    note: 'An enclosure is a floor, four walls standing on it, a lid on top and a handle on the lid.',
    mounts: { circuit: { to: 0, face: 'top', span: 0.34 } },
    parts: [
      p('floor', 'panel', 'cardboard', [0.9, 0.05, 0.7]),
      p('side wall', 'panel', 'cardboard', [0.9, 0.44, 0.04], { to: 0, face: 'front' },
        { array: { mode: 'mirror_z', radius: 0.35, count: 2 } }),
      p('end wall', 'panel', 'cardboard', [0.04, 0.44, 0.66], { to: 0, face: 'left' },
        { array: { mode: 'mirror_x', radius: 0.45, count: 2 } }),
      p('lid', 'panel', 'cardboard', [0.94, 0.05, 0.74], { to: 1, face: 'top' }),
      p('handle', 'channel', 'plastic', [0.18, 0.05, 0.06], { to: 3, face: 'top' })
    ]
  },
  {
    id: 'keyboard', class: 'keyboard', label: 'keyboard',
    words: ['keyboard', 'keypad', 'macropad', 'piano', 'synth', 'console'],
    note: 'A keyboard is a tray with a plate over it, rows of keys on the plate and feet that tilt it up at the back.',
    mounts: { circuit: { to: 0, face: 'inside', span: 0.4 } },
    parts: [
      p('tray', 'box', 'plastic', [1.0, 0.06, 0.36]),
      p('plate', 'panel', 'alloy', [0.96, 0.02, 0.32], { to: 0, face: 'top' }),
      p('key row', 'box', 'plastic', [0.9, 0.04, 0.05], { to: 1, face: 'top' },
        { array: { mode: 'row', count: 4, spacing: 0.07 }, rot: [90, 0, 0] }),
      p('spacebar', 'box', 'plastic', [0.34, 0.04, 0.05], { to: 1, face: 'top', dz: 0.12 }),
      p('foot', 'wedge', 'plastic', [0.08, 0.04, 0.06], { to: 0, face: 'bottom' },
        { array: { mode: 'mirror_x', radius: 0.4, count: 2 } })
    ]
  }
];

/* ------------------------------------------------------------------ */
/* finding the right one                                               */
/* ------------------------------------------------------------------ */
const STOP = new Set(('a an the and or of for with to in on at that this it is are be build make'
  + ' design create me my some something please can you new small big simple').split(/\s+/));

function words(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/).filter(w => w.length > 2 && !STOP.has(w))
    .map(w => (w.endsWith('s') && w.length > 4 ? w.slice(0, -1) : w));
}

/* What the request is ABOUT: the last word before any preposition. Same
   rule as skills.headNoun and library.headTerm, and a third copy for the
   same reason — all three files import nothing, so none of them can reach
   the others'. wiring.test.mjs checks they agree.

   It matters here because an English compound puts the head LAST: "a desk
   lamp" is a lamp, and without this the shop matched `desk` and offered to
   build a table. */
export function headWord(request) {
  const text = String(request || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/);
  const cut = text.findIndex(w => ['with', 'for', 'that', 'which', 'holding', 'carrying', 'on', 'to'].includes(w));
  const head = (cut > 0 ? text.slice(0, cut) : text).filter(w => w.length > 2 && !STOP.has(w));
  const last = head[head.length - 1] || '';
  return last.endsWith('s') && last.length > 4 ? last.slice(0, -1) : last;
}

/* The best archetype for a request, scored the same way everything else in
   this shop scores a match: a longer word is stronger evidence than a
   short one, the word the request is ABOUT beats one it merely mentions,
   and position breaks a tie. */
const PREPS = ['with', 'for', 'that', 'which', 'holding', 'carrying', 'to', 'on'];

/* Everything up to the first preposition — the thing being asked for, as
   opposed to where it goes or what it holds. "A lamp for a workbench" is a
   lamp, and scoring the whole sentence matched `workbench` and offered a
   table. Falls back to the whole request when that leaves nothing to go
   on, because "something to keep the door open" is all context. */
function subjectOf(text) {
  const at = PREPS.map(w => text.indexOf(` ${w} `)).filter(i => i > 0).sort((a, b) => a - b)[0];
  const head = at > 0 ? text.slice(0, at) : text;
  return words(head).length ? head : text;
}

export function matchArchetype(request) {
  const full = String(request || '').toLowerCase();
  const text = subjectOf(full);
  const toks = new Set(words(text));
  if (!toks.size) return null;
  const head = headWord(text);

  let best = null;
  for (const a of ARCHETYPES) {
    let score = 0;
    for (const w of a.words) {
      const key = w.endsWith('s') && w.length > 4 ? w.slice(0, -1) : w;
      if (w.includes(' ')) {
        if (text.includes(w)) score += 2.2;
        continue;
      }
      if (!toks.has(key)) continue;
      /* Position is a TIE-BREAK, not a veto. Weighted the way it first was,
         "a sports car" scored below the bar purely because the word `car`
         came at the end of a three-word sentence, and the shop went back
         to guessing at a car from keywords. */
      const at = text.indexOf(key);
      const early = 1 - Math.min(0.5, at < 0 ? 0 : at / Math.max(12, text.length));
      /* SPECIFICITY leads and the head noun breaks the tie, not the other
         way round. Weighted head-first, "a loudspeaker cabinet" matched
         `cabinet` and offered to build shelving — the longer, rarer word
         in a compound is what says which thing it is. */
      const isHead = key === head;
      score += (0.9 + Math.min(1.4, key.length / 8)) * (0.75 + 0.25 * early) * (isHead ? 1.25 : 1);
    }
    if (score > 0 && (!best || score > best.score)) best = { archetype: a, score };
  }
  return best && best.score >= 0.9 ? best.archetype : null;
}

export function archetypeById(id) {
  return ARCHETYPES.find(a => a.id === id) || null;
}

/* A deep copy, because an archetype is shared and a plan gets edited. */
export function partsOf(archetype) {
  return (archetype?.parts || []).map(part => ({
    ...part,
    size: part.size.slice(),
    ...(part.attach ? { attach: { ...part.attach } } : {}),
    ...(part.array ? { array: { ...part.array } } : {}),
    ...(part.rot ? { rot: part.rot.slice() } : {})
  }));
}

/* ------------------------------------------------------------------ */
/* putting one thing inside another                                    */
/* ------------------------------------------------------------------ */
/* THE POINT OF THE FILE. "A car with a V12" is two objects and the planner
   could only ever build one of them. Every part of the subsystem is
   renumbered onto the end of the host — a local `attach.to` of 2 becomes
   host.length + 2 — and its ROOT, which had no attachment because it used
   to stand on the pedestal by itself, is bolted to the named mount.

   Get the renumbering wrong and nothing throws: half the subsystem
   reparents onto whatever the host happens to have at that index, solves
   fine and renders fine. Same failure as mergeSubplans, same test. */
export function scaleParts(parts, k) {
  if (!(k > 0) || k === 1) return parts;
  return parts.map(part => ({
    ...part,
    size: part.size.map(v => Math.max(0.01, v * k)),
    ...(part.attach ? {
      attach: {
        ...part.attach,
        ...(part.attach.dx ? { dx: part.attach.dx * k } : {}),
        ...(part.attach.dy ? { dy: part.attach.dy * k } : {}),
        ...(part.attach.dz ? { dz: part.attach.dz * k } : {})
      }
    } : {}),
    ...(part.array ? {
      array: {
        ...part.array,
        ...(part.array.radius ? { radius: part.array.radius * k } : {}),
        ...(part.array.spacing ? { spacing: part.array.spacing * k } : {})
      }
    } : {})
  }));
}

/* How big the block is at the moment, along its longest axis. Approximate
   on purpose: it is only ever used to work out a scale factor, and asking
   the solver would mean importing it. */
export function spanOf(parts) {
  let span = 0;
  for (const part of parts) span = Math.max(span, ...part.size);
  return span || 1;
}

export function fitFactor(parts, span) {
  if (!(span > 0)) return 1;
  const have = spanOf(parts);
  return have > 0 ? Math.min(1, span / have) : 1;
}

export function compose(hostParts, addParts, mount) {
  const host = (hostParts || []).slice();
  if (!addParts?.length) return { parts: host, offset: host.length, scale: 1 };

  const scale = mount?.span ? fitFactor(addParts, mount.span) : 1;
  const scaled = scaleParts(addParts, scale);
  const offset = host.length;
  const to = Math.min(Math.max(0, Math.round(mount?.to ?? 0)), Math.max(0, offset - 1));

  const moved = scaled.map((part, i) => {
    const out = { ...part };
    if (i === 0 || !part.attach) {
      /* the subsystem's own root: it had nowhere to be, and now it has */
      out.attach = {
        to,
        face: mount?.face || 'top',
        ...(mount?.dx ? { dx: mount.dx } : {}),
        ...(mount?.dy ? { dy: mount.dy } : {}),
        ...(mount?.dz ? { dz: mount.dz } : {})
      };
    } else {
      out.attach = { ...part.attach, to: offset + part.attach.to };
    }
    return out;
  });

  return { parts: host.concat(moved), offset, scale };
}

/* ------------------------------------------------------------------ */
/* what moves                                                          */
/* ------------------------------------------------------------------ */
/* An object that is switched on should DO something. The engine already
   drives its own crank and pistons; this is everything else — a wheel
   turns, a propeller spins, a gear turns against its neighbour. Returned
   in exactly the shape engine.js returns motion in, so world.js drives
   both from one list and knows nothing about either. */
const MOVER_RULES = {
  wheel: { kind: 'spin', axis: 'x', rpm: 42 },
  rotor: { kind: 'spin', axis: 'y', rpm: 260 },
  prop: { kind: 'spin', axis: 'y', rpm: 420 },
  gear: { kind: 'spin', axis: 'z', rpm: 28 },
  drum: { kind: 'spin', axis: 'x', rpm: 30 },
  turntable: { kind: 'spin', axis: 'y', rpm: 8 }
};

/* Parts come off a VALIDATED plan, so `rot` is in radians here — the
   archetypes are authored in degrees and validatePlan converts. Comparing
   a radian against 45 is always false, which is how every wheel ended up
   spinning about the axis it was NOT stood up onto. */
const QUARTER = Math.PI / 4;

export function catalogMotion(parts) {
  const out = [];
  (parts || []).forEach((part, i) => {
    const rule = MOVER_RULES[part?.moves];
    if (!rule) return;
    /* A round part turns about its OWN axis, which is its local +Y, and
       that axis goes wherever the part was turned. A wheel is drawn lying
       flat and stood up by a 90° roll about Z, which lays its axle along
       X — so that is the axle it turns about. */
    const rot = part.rot || [0, 0, 0];
    let axis = rule.axis;
    if (['wheel', 'gear', 'rotor', 'prop', 'drum'].includes(part.moves)) {
      axis = Math.abs(rot[2]) > QUARTER ? 'x' : Math.abs(rot[0]) > QUARTER ? 'z' : 'y';
    }
    out.push({ part: i, kind: rule.kind, axis, rpm: rule.rpm });
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* what the planner is told                                            */
/* ------------------------------------------------------------------ */
/* One line about the thing being asked for, folded into the planning and
   critique prompts. A model is far better at filling in a structure than
   at inventing one, and "a car is a chassis with wheels hung off both
   ends" is the difference between a car and a drum with a wheel on it. */
export function catalogBlock(request) {
  const a = matchArchetype(request);
  if (!a) return '';
  const names = a.parts.map(part => part.name);
  const mounts = Object.keys(a.mounts || {});
  return `
HOW A ${a.label.toUpperCase()} GOES TOGETHER
${a.note}
The parts one is made of: ${[...new Set(names)].join(', ')}.
${mounts.length ? `If the request also asks for ${mounts.join(' or a ')}, that is a SEPARATE set of parts mounted on this one — build both.` : ''}
Use the same part names. Do not build a stack of anonymous blocks.
`;
}

/* Every archetype, for the settings panel and the tests. */
export const ARCHETYPE_IDS = ARCHETYPES.map(a => a.id);
